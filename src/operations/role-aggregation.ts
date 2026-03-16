import { logger, ConnectorError } from '@sailpoint/connector-sdk'
import { EntitlementV2025, RequestabilityForRoleV2025 } from 'sailpoint-api-client'
import { ISCClient, LightweightRole } from '../isc-client'
import { Config } from '../model/config'
import { RoleProperties } from '../model/propertyDefinitions'
import {
    buildEntitlementVelocityContext,
    buildApprovalSchemesConfig,
    buildEntitlementPatch,
    detectRequestableAndConfigChanges,
    entitlementToRef,
    evaluateVelocityExpression,
    pushToGroupMap,
    runWithConcurrency,
    searchWithFallback,
    shouldSkipUpdate,
    stringToMembership,
} from '../utils'

// Limit concurrent API calls to avoid overwhelming the API
const API_CONCURRENCY = 8

/**
 * Aggregates roles from entitlements in ISC (Identity Security Cloud).
 *
 * Flow:
 * 1. Resolve source by spConnectorInstanceId.
 * 2. For each definition: fetch entitlements via query, group by entitlementExpression result.
 * 3. For each group: build RoleProperties (entitlements, requestable, approval, membership).
 * 4. Create or update roles in ISC.
 * 5. Optionally delete stale roles (when deleteStaleRoles is enabled).
 */
export async function aggregateRoles(config: Config, isc: ISCClient): Promise<void> {
    const roleMap = new Map<string, RoleProperties>()
    const entitlementMap = new Map<string, EntitlementV2025[]>()
    const existingRoleMap = new Map<string, LightweightRole>()
    const allEntitlementIds = new Set<string>()

    // Find the connector's source (needed for ownerId)
    const sources = await isc.listSources()
    const source = sources.find(
        (x) => (x.connectorAttributes as any).spConnectorInstanceId === config.spConnectorInstanceId
    )

    if (!source) {
        const error = `Unable to find source with spConnectorInstanceId "${config.spConnectorInstanceId}"`
        throw new ConnectorError(error)
    }

    const deleteStaleRoles = config.roles!.some(
        (d) => d.deleteStaleRoles === true || String(d.deleteStaleRoles) === 'true'
    )

    // Phase 1: Collect entitlements and group them per definition
    roles: for (const definition of config.roles!) {
        logger.debug(`Processing definition: ${definition.name}`)
        entitlementMap.clear()
        const entitlements = await isc.listEntitlements(definition.query)
        logger.debug(`Found ${entitlements.length} entitlements for definition ${definition.name}`)

        // Collect entitlement IDs (for a single search later)
        for (const ent of entitlements) {
            if (ent.id) allEntitlementIds.add(ent.id)
        }

        // Evaluate entitlementExpression; group by role name (definition name or expression result)
        entitlements: for (const entitlement of entitlements) {
            logger.debug(`Processing entitlement: ${entitlement.name} (${entitlement.id})`)
            const context = buildEntitlementVelocityContext(entitlement, {
                definitionName: definition.name,
            })
            let roleName = definition.name
            const name = evaluateVelocityExpression(definition.entitlementExpression, context)
            // Skip if expression evaluated to empty
            if (!name) {
                logger.info(
                    `Skipping entitlement ${entitlement.id}: expression evaluated to empty`
                )
                continue entitlements
            }

            if (definition.groupEntitlements) {
                // Each unique expression result becomes a separate role
                logger.debug(`Grouping by expression result: ${name}`)
                roleName = name
            } else {
                logger.debug(`No grouping - using definition name: ${roleName}`)
            }
            pushToGroupMap(entitlementMap, roleName, entitlement)
        }

        // Phase 2: For each group in this definition, build role properties
        // In delete mode, we still need to track expected role names, but skip expensive property building
        groups: for (const groupName of entitlementMap.keys()) {
            logger.debug(`Processing group: ${groupName}`)

            // In delete mode, just track the name to know which roles to delete
            if (deleteStaleRoles) {
                logger.debug(`Delete mode: tracking role name for deletion: ${groupName}`)
                roleMap.set(groupName, {} as RoleProperties)
                continue groups
            }

            // Create/update mode: build full role properties
            const ownerId = source.owner!.id!
            const groupEntitlements = entitlementMap.get(groupName)!
            
            const roleProperties: RoleProperties = {
                ownerId,
                entitlements: groupEntitlements.map(entitlementToRef),
                requestable: definition.requestable,
            }
            
            if (definition.approverType) {
                roleProperties.accessRequestConfig = buildApprovalSchemesConfig(definition.approverType) as RequestabilityForRoleV2025
            }

            // Evaluate membership assignment definition
            if (definition.assignmentDefinition) {
                const assignmentContext: Record<string, unknown> = {
                    name: groupName,
                    definitionName: definition.name,
                }
                
                if (definition.groupEntitlements) {
                    // Multiple entitlements grouped: provide all as 'entitlements'
                    assignmentContext.entitlements = groupEntitlements
                } else {
                    // Single entitlement: provide as 'entitlement'
                    assignmentContext.entitlement = groupEntitlements[0]
                }
                
                const assignmentDefinition = evaluateVelocityExpression(definition.assignmentDefinition, assignmentContext)
                roleProperties.membership = await stringToMembership(assignmentDefinition, sources)
            }

            const existingRole = existingRoleMap.get(groupName)
            if (existingRole) {
                roleProperties.id = existingRole.id
            }
            
            roleMap.set(groupName, roleProperties)
        }
    }

    // Phase 3: Create or update roles in ISC (with concurrency)
    // Skip when delete option is enabled: no creations or updates, only deletions
    if (!deleteStaleRoles) {
        await runWithConcurrency(Array.from(roleMap.entries()), API_CONCURRENCY, async ([roleName, role]) => {
            const { id, ownerId, entitlements, requestable, accessRequestConfig, membership } = role

            if (id) {
                const existingRole = existingRoleMap.get(roleName)
                if (!existingRole) {
                    logger.warn(`Role ${roleName} has id but no cached existing role, skipping update`)
                    return
                }
                logger.debug(`Evaluating existing role for update: ${roleName}`)
                const changes = detectRequestableAndConfigChanges(
                    existingRole,
                    entitlements,
                    requestable,
                    accessRequestConfig,
                    membership
                )
                if (shouldSkipUpdate(changes, true)) {
                    logger.debug(`No changes detected for role ${roleName}, skipping update`)
                    return
                }
                const roleUpdate = buildEntitlementPatch(entitlements, {
                    requestable,
                    accessRequestConfig,
                    membership,
                })
                try {
                    logger.debug(`Updating existing role: ${roleName}`)
                    const rolePayload = await isc.updateRole(id, roleUpdate)
                    role.id = rolePayload.id!
                } catch (error) {
                    logger.error(`Error updating role: ${error}`)
                }
            } else {
                logger.debug(`Creating new role: ${roleName}`)
                try {
                    const rolePayload = await isc.createRole(
                        roleName,
                        ownerId,
                        entitlements,
                        requestable,
                        accessRequestConfig,
                        membership
                    )
                    role.id = rolePayload.id!
                } catch (error) {
                    logger.error(`Error creating role: ${error}`)
                }
            }
        })
    }

    // Phase 4: Delete stale roles (when toggle enabled) with concurrency
    if (!deleteStaleRoles) return

    if (allEntitlementIds.size === 0) {
        logger.debug('No entitlements found for delete run, skipping')
        return
    }

    const currentRoleNames = new Set(roleMap.keys())
    logger.debug(`Delete mode: all role names tracked in roleMap: ${Array.from(currentRoleNames).join(', ')}`)

    if (currentRoleNames.size === 0) {
        logger.debug('No role names produced by definitions, skipping deletion')
        return
    }

    // Fetch existing roles using search with automatic fallback
    const searchResults = await searchWithFallback({
        entitlementIds: Array.from(allEntitlementIds),
        names: Array.from(currentRoleNames),
        searchByEntitlements: (ids) => isc.searchRolesByEntitlements(ids),
        searchByNames: (names) => isc.searchRolesByNames(names),
        entityType: 'roles',
    })

    for (const role of searchResults) {
        if (role.name) {
            existingRoleMap.set(role.name, role)
        }
    }

    logger.debug(`Expected role names for deletion: ${Array.from(currentRoleNames).join(', ')}`)
    logger.debug(`Existing role names from search: ${Array.from(existingRoleMap.keys()).join(', ')}`)

    // Filter to only roles whose names match those produced by our definitions
    const rolesToDelete = Array.from(existingRoleMap.values()).filter(
        (role) => role.id && role.name && currentRoleNames.has(role.name)
    )

    logger.debug(`Delete run: found ${existingRoleMap.size} existing roles, ${currentRoleNames.size} expected role names, ${rolesToDelete.length} roles to delete`)
    await runWithConcurrency(rolesToDelete, API_CONCURRENCY, async (role) => {
        try {
            logger.info(`Deleting role: ${role.name}`)
            await isc.deleteRole(role.id!)
        } catch (error) {
            logger.error(`Error deleting role ${role.name}: ${error}`)
        }
    })
}
