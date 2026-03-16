import { logger } from '@sailpoint/connector-sdk'
import {
    EntitlementV2025,
    JsonPatchOperationV2025,
    RequestabilityV2025,
    SourceAppV2025,
} from 'sailpoint-api-client'
import { ISCClient } from '../isc-client'
import { AccessProfileDefinition, Config } from '../model/config'
import {
    buildEntitlementVelocityContext,
    buildApprovalSchemesConfig,
    buildEntitlementPatch,
    detectRequestableAndConfigChanges,
    entitlementToRef,
    evaluateVelocityExpression,
    runWithConcurrency,
    searchWithFallback,
    shouldSkipUpdate,
} from '../utils'

// Limit concurrent API calls to avoid overwhelming the API
const API_CONCURRENCY = 8

interface AccessProfileData {
    name: string
    entitlements: EntitlementV2025[]
    appName: string
    sourceId: string
    ownerId: string
}

interface ApplicationData {
    name: string
    sourceId: string
    accessProfileNames: string[]
}

/**
 * Main entry point: processes one access profile definition
 */
export async function aggregateAccessProfiles(
    config: Config,
    isc: ISCClient,
    definition: AccessProfileDefinition
): Promise<void> {
    logger.info(`Processing access profile definition: ${definition.name}`)

    const deleteMode = definition.deleteMode === true || String(definition.deleteMode) === 'true'

    if (deleteMode) {
        await deleteAccessProfilesAndApps(isc, definition)
    } else {
        await createOrUpdateAccessProfilesAndApps(isc, definition)
    }
}

/**
 * Create or update access profiles and applications
 */
async function createOrUpdateAccessProfilesAndApps(
    isc: ISCClient,
    definition: AccessProfileDefinition
): Promise<void> {
    // Step 1: Fetch and group entitlements into access profiles
    const accessProfiles = await buildAccessProfilesFromEntitlements(isc, definition)
    if (accessProfiles.length === 0) {
        logger.info(`No access profiles to process for definition ${definition.name}`)
        return
    }

    logger.info(`Built ${accessProfiles.length} access profiles from entitlements`)

    // Step 2: Validate source consistency
    validateSourceConsistency(accessProfiles, definition)

    // Step 3: Process access profiles (create/update) and get their IDs
    const apNameToIdMap = await processAccessProfiles(isc, definition, accessProfiles)
    logger.info(`Processed ${apNameToIdMap.size} access profiles`)

    // Step 4: Process applications (if enabled)
    if (definition.createApplication && apNameToIdMap.size > 0) {
        await processApplications(isc, definition, accessProfiles, apNameToIdMap)
    }
}

/**
 * Process all access profiles: create or update them, return map of name to ID
 */
async function processAccessProfiles(
    isc: ISCClient,
    definition: AccessProfileDefinition,
    accessProfiles: AccessProfileData[]
): Promise<Map<string, string>> {
    logger.info(`Processing ${accessProfiles.length} access profiles`)

    // Cache sources (to get owner IDs) - fetch in parallel
    const sourceCache = new Map<string, SourceAppV2025>()
    const uniqueSourceIds = new Set(accessProfiles.map(ap => ap.sourceId))

    const sourceResults = await Promise.allSettled(
        Array.from(uniqueSourceIds).map(async (sourceId) => {
            const source = await isc.getSource(sourceId)
            return { sourceId, source }
        })
    )

    for (const result of sourceResults) {
        if (result.status === 'fulfilled') {
            sourceCache.set(result.value.sourceId, result.value.source)
        } else {
            logger.error(`Error fetching source: ${result.reason}`)
        }
    }

    // Validate all sources were fetched
    if (sourceCache.size !== uniqueSourceIds.size) {
        logger.error(`Failed to fetch all sources: expected ${uniqueSourceIds.size}, got ${sourceCache.size}`)
    }

    // Search for existing access profiles
    const entitlementIds = new Set<string>()
    const apNames = new Set<string>()
    for (const ap of accessProfiles) {
        apNames.add(ap.name)
        for (const ent of ap.entitlements) {
            if (ent.id) entitlementIds.add(ent.id)
        }
    }

    const existingAps = await searchWithFallback({
        entitlementIds: Array.from(entitlementIds),
        names: Array.from(apNames),
        searchByEntitlements: (ids) => isc.searchAccessProfilesByEntitlements(ids),
        searchByNames: (names) => isc.searchAccessProfilesByNames(names),
        entityType: 'access profiles',
    })

    const existingApMap = new Map(existingAps.map(ap => [ap.name, ap]))

    logger.debug(`Found ${existingAps.length} existing access profiles`)

    // Create/update access profiles in parallel
    const apNameToIdMap = new Map<string, string>()
    const results = await Promise.allSettled(
        accessProfiles.map(async (apData) => {
            const existingAp = existingApMap.get(apData.name)
            const entitlementRefs = apData.entitlements.map(entitlementToRef)
            const source = sourceCache.get(apData.sourceId)

            if (!source) {
                logger.error(`Source ${apData.sourceId} not found in cache, skipping AP ${apData.name}`)
                return { name: apData.name, id: undefined }
            }

            if (!source.owner?.id) {
                logger.error(`Source ${apData.sourceId} has no owner, skipping AP ${apData.name}`)
                return { name: apData.name, id: undefined }
            }

            const ownerId = source.owner.id

            const accessRequestConfig = definition.approverType
                ? (buildApprovalSchemesConfig(definition.approverType) as RequestabilityV2025)
                : undefined

            let apId: string | undefined

            if (existingAp?.id) {
                // Update existing
                const changes = detectRequestableAndConfigChanges(
                    existingAp,
                    entitlementRefs,
                    definition.requestable,
                    accessRequestConfig
                )
                if (shouldSkipUpdate(changes)) {
                    logger.debug(`No changes for access profile ${apData.name}, keeping existing`)
                    apId = existingAp.id
                } else {
                    try {
                        const updated = await isc.updateAccessProfile(
                            existingAp.id,
                            buildEntitlementPatch(entitlementRefs, { requestable: definition.requestable, accessRequestConfig })
                        )
                        apId = updated.id!
                        logger.info(`Updated access profile: ${apData.name}`)
                    } catch (error) {
                        logger.error(`Error updating access profile ${apData.name}: ${error}`)
                    }
                }
            } else {
                // Create new
                try {
                    const created = await isc.createAccessProfile(
                        apData.name,
                        ownerId,
                        apData.sourceId,
                        entitlementRefs,
                        definition.requestable,
                        accessRequestConfig
                    )
                    apId = created.id!
                    logger.info(`Created access profile: ${apData.name}`)
                } catch (error) {
                    logger.error(`Error creating access profile ${apData.name}: ${error}`)
                }
            }

            return { name: apData.name, id: apId }
        })
    )

    // Collect successful results
    for (const result of results) {
        if (result.status === 'fulfilled' && result.value.id) {
            apNameToIdMap.set(result.value.name, result.value.id)
        }
    }

    return apNameToIdMap
}

/**
 * Process applications: create or update them and link access profiles
 */
async function processApplications(
    isc: ISCClient,
    definition: AccessProfileDefinition,
    accessProfiles: AccessProfileData[],
    apNameToIdMap: Map<string, string>
): Promise<void> {
    // Group access profiles into applications
    const applications = groupAccessProfilesIntoApplications(accessProfiles, definition)

    if (applications.length === 0) {
        logger.warn(`No applications to process for definition ${definition.name}`)
        return
    }

    logger.info(`Processing ${applications.length} applications`)

    // Search for existing apps
    const sourceIds = new Set(accessProfiles.map(ap => ap.sourceId))
    const existingApps = await isc.listAppsBySources(Array.from(sourceIds))
    const existingAppMap = new Map(existingApps.filter(app => app.name).map(app => [app.name!, app]))

    logger.debug(`Found ${existingApps.length} existing apps`)

    // Process each application sequentially to avoid race conditions
    for (const appData of applications) {
        logger.info(`Processing application: ${appData.name}`)

        // Step 1: Create app if needed
        let appId: string
        const existingApp = existingAppMap.get(appData.name)
        if (existingApp?.id) {
            appId = existingApp.id
            logger.debug(`Using existing app: ${appData.name} (${appId})`)
        } else {
            try {
                const newApp = await isc.createApp(appData.name, appData.sourceId)
                appId = newApp.id!
                logger.info(`Created application: ${appData.name} (${appId})`)
                
                // Wait for the app to be fully ready before updating
                // This prevents race conditions where the app isn't immediately available
                logger.debug(`Waiting 2 seconds for newly created app ${appData.name} to be ready`)
                await new Promise(resolve => setTimeout(resolve, 2000))
            } catch (error) {
                logger.error(`Error creating app ${appData.name}: ${error}`)
                continue
            }
        }

        // Step 2: Collect AP IDs for this app
        const apIdsForApp: string[] = []
        for (const apName of appData.accessProfileNames) {
            const apId = apNameToIdMap.get(apName)
            if (apId) {
                apIdsForApp.push(apId)
            } else {
                logger.warn(`Access profile ${apName} has no ID, skipping for app ${appData.name}`)
            }
        }

        if (apIdsForApp.length === 0) {
            logger.warn(`No access profiles available for app ${appData.name}, skipping app update`)
            continue
        }

        // Step 3: Update app with access profile IDs
        logger.info(`Updating app ${appData.name} with ${apIdsForApp.length} access profiles`)

        const appUpdate: JsonPatchOperationV2025[] = [
            { op: 'replace', path: '/accessProfiles', value: apIdsForApp },
            { op: 'replace', path: '/enabled', value: true },
            { op: 'replace', path: '/appCenterEnabled', value: true },
            { op: 'replace', path: '/provisionRequestEnabled', value: true },
            { op: 'replace', path: '/matchAllAccounts', value: false },
        ]

        try {
            await isc.updateSourceAccessProfiles(appId, appUpdate)
            logger.info(`Updated application: ${appData.name}`)
        } catch (error) {
            logger.error(`Error updating app ${appData.name}: ${error}`)
        }
    }
}

/**
 * Delete access profiles and applications
 */
async function deleteAccessProfilesAndApps(
    isc: ISCClient,
    definition: AccessProfileDefinition
): Promise<void> {
    logger.info(`Delete mode for definition: ${definition.name}`)

    // Step 1: Fetch entitlements and determine what access profiles/apps SHOULD exist
    const expectedApNames = new Set<string>()
    const expectedAppNames = new Set<string>()
    const sourceIds = new Set<string>()
    const entitlementIds = new Set<string>()

    const entitlements = await isc.listEntitlements(definition.query)
    logger.info(`Found ${entitlements.length} entitlements for definition ${definition.name}`)

    // Collect source IDs and entitlement IDs
    for (const ent of entitlements) {
        if (ent.source?.id) sourceIds.add(ent.source.id)
        if (ent.id) entitlementIds.add(ent.id)
    }

    // Group entitlements to determine expected access profile names
    const entitlementGroups = new Map<string, EntitlementV2025[]>()
    for (const entitlement of entitlements) {
        const context = buildEntitlementVelocityContext(entitlement, {
            definitionName: definition.name,
        })
        const apName = evaluateVelocityExpression(definition.entitlementExpression, context)

        if (!apName || apName === definition.entitlementExpression) {
            continue
        }

        if (!entitlementGroups.has(apName)) {
            entitlementGroups.set(apName, [])
        }
        entitlementGroups.get(apName)!.push(entitlement)
    }

    // Determine which groups are valid (handle groupEntitlements logic)
    for (const [apName, ents] of entitlementGroups.entries()) {
        if (ents.length > 1 && !definition.groupEntitlements) {
            logger.debug(`Skipping AP ${apName} in delete mode: has ${ents.length} entitlements but groupEntitlements is false`)
            continue
        }

        expectedApNames.add(apName)

        if (definition.createApplication) {
            if (definition.groupAccessProfiles) {
                if (!definition.applicationExpression) {
                    logger.error(`Definition ${definition.name}: groupAccessProfiles is true but applicationExpression not defined`)
                    continue
                }
                const appContext: Record<string, unknown> = {
                    name: apName,
                    definitionName: definition.name,
                }
                appContext.entitlement = definition.groupEntitlements ? ents : ents[0]
                if (definition.groupEntitlements) {
                    appContext.entitlements = ents
                }
                const appName = evaluateVelocityExpression(definition.applicationExpression, appContext)
                if (appName && appName !== definition.applicationExpression) {
                    expectedAppNames.add(appName)
                }
            } else {
                expectedAppNames.add(definition.name)
            }
        }
    }

    logger.info(`Expected: ${expectedApNames.size} access profiles, ${expectedAppNames.size} apps`)

    // Step 2: Find existing access profiles and apps
    const existingAps = await searchWithFallback({
        entitlementIds: Array.from(entitlementIds),
        names: Array.from(expectedApNames),
        searchByEntitlements: (ids) => isc.searchAccessProfilesByEntitlements(ids),
        searchByNames: (names) => isc.searchAccessProfilesByNames(names),
        entityType: 'access profiles',
    })

    const existingApps = sourceIds.size > 0
        ? await isc.listAppsBySources(Array.from(sourceIds))
        : []

    logger.info(`Existing: ${existingAps.length} access profiles, ${existingApps.length} apps`)

    // Determine which access profiles will be deleted
    const apsToDelete = existingAps.filter(ap => ap.name && expectedApNames.has(ap.name) && ap.id)
    const apIdsToDelete = new Set(apsToDelete.map(ap => ap.id!))

    logger.info(`Will delete ${apsToDelete.length} access profiles`)
    logger.debug(`Access profile IDs to delete: ${Array.from(apIdsToDelete).join(', ')}`)

    // Step 3: Get access profiles for each application
    logger.debug('Fetching access profiles for each application')

    type AppWithAccessProfiles = SourceAppV2025 & { accessProfileIds: string[] }

    const appsWithAccessProfiles = await runWithConcurrency(existingApps, API_CONCURRENCY, async (app): Promise<AppWithAccessProfiles | null> => {
        try {
            if (!app.id) {
                logger.warn(`App ${app.name} has no ID, skipping`)
                return null
            }
            logger.debug(`Fetching access profiles for app ${app.name} (${app.id})`)
            const apIds = await isc.getAppAccessProfiles(app.id)
            logger.debug(`App ${app.name} has ${apIds.length} access profiles`)
            return {
                ...app,
                accessProfileIds: apIds
            } as AppWithAccessProfiles
        } catch (error) {
            logger.error(`Could not fetch access profiles for app ${app.name}: ${error}`)
            return null
        }
    })

    const validApps = appsWithAccessProfiles.filter((app): app is AppWithAccessProfiles => app !== null)
    logger.info(`Successfully fetched access profile details for ${validApps.length} apps`)

    // Step 4: Remove access profiles from applications that reference them
    const appsToUpdate = validApps.filter(app => {
        if (!app.accessProfileIds || app.accessProfileIds.length === 0) return false
        return app.accessProfileIds.some(apId => apIdsToDelete.has(apId))
    })

    if (appsToUpdate.length > 0) {
        logger.info(`Removing access profiles from ${appsToUpdate.length} applications before deletion`)
        await runWithConcurrency(appsToUpdate, API_CONCURRENCY, async (app) => {
            try {
                // Filter out the access profiles we're about to delete
                const remainingAps = app.accessProfileIds.filter(apId => !apIdsToDelete.has(apId))

                logger.info(`Updating app ${app.name}: removing ${app.accessProfileIds.length - remainingAps.length} access profiles (${remainingAps.length} remaining)`)
                await isc.updateSourceAccessProfiles(app.id!, [
                    { op: 'replace', path: '/accessProfiles', value: remainingAps },
                ])
            } catch (error) {
                logger.error(`Error updating app ${app.name}: ${error}`)
            }
        })
    } else {
        logger.info('No applications have the access profiles being deleted')
    }

    // Step 5: Delete applications that were created by this connector
    const appsToDeleteByName = existingApps.filter(app => {
        if (!app.name || !app.id) return false
        
        if (definition.createApplication && expectedAppNames.size > 0) {
            return expectedAppNames.has(app.name)
        }
        
        return app.name === definition.name
    })

    if (appsToDeleteByName.length > 0) {
        logger.info(`Deleting ${appsToDeleteByName.length} applications`)

        await runWithConcurrency(appsToDeleteByName, API_CONCURRENCY, async (app) => {
            try {
                logger.info(`Deleting application: ${app.name}`)
                await isc.deleteSourceApp(app.id!)
            } catch (error) {
                logger.error(`Error deleting app ${app.name}: ${error}`)
            }
        })
    }

    // Step 6: Delete access profiles that match expected names
    if (apsToDelete.length > 0) {
        logger.info(`Deleting ${apsToDelete.length} access profiles`)

        await runWithConcurrency(apsToDelete, API_CONCURRENCY, async (ap) => {
            try {
                logger.info(`Deleting access profile: ${ap.name}`)
                await isc.deleteAccessProfile(ap.id!)
            } catch (error) {
                logger.error(`Error deleting access profile ${ap.name}: ${error}`)
            }
        })
    }
}

/**
 * Build access profile data structures from entitlements
 */
async function buildAccessProfilesFromEntitlements(
    isc: ISCClient,
    definition: AccessProfileDefinition
): Promise<AccessProfileData[]> {
    const entitlements = await isc.listEntitlements(definition.query)
    logger.info(`Found ${entitlements.length} entitlements for definition ${definition.name}`)

    if (entitlements.length === 0) {
        return []
    }

    // Group entitlements by access profile name (from entitlementExpression)
    const groups = new Map<string, EntitlementV2025[]>()

    for (const entitlement of entitlements) {
        if (!entitlement.source?.id) {
            logger.warn(`Entitlement ${entitlement.id} has no source ID, skipping`)
            continue
        }

        const context = buildEntitlementVelocityContext(entitlement, {
            definitionName: definition.name,
        })
        const apName = evaluateVelocityExpression(definition.entitlementExpression, context)

        if (!apName || apName === definition.entitlementExpression) {
            logger.debug(`Skipping entitlement ${entitlement.id}: expression evaluated to empty`)
            continue
        }

        if (!groups.has(apName)) {
            groups.set(apName, [])
        }
        groups.get(apName)!.push(entitlement)
    }

    // Build access profile data (handling groupEntitlements logic and source validation)
    const accessProfiles: AccessProfileData[] = []

    for (const [apName, ents] of groups.entries()) {
        if (ents.length > 1 && !definition.groupEntitlements) {
            logger.warn(`Access profile ${apName} has ${ents.length} entitlements but groupEntitlements is false, discarding`)
            continue
        }

        // Validate all entitlements have the same source
        const firstSourceId = ents[0].source!.id!
        const mixedSources = ents.some(e => e.source?.id !== firstSourceId)

        if (mixedSources) {
            const sourceIds = Array.from(new Set(ents.map(e => e.source?.id).filter(Boolean)))
            logger.error(
                `Access profile ${apName} would combine entitlements from multiple sources [${sourceIds.join(', ')}]. ` +
                `This is not allowed - access profiles must contain entitlements from a single source only. ` +
                `Discarding this access profile. Fix by ensuring entitlementExpression doesn't group cross-source entitlements.`
            )
            continue
        }

        accessProfiles.push({
            name: apName,
            entitlements: ents,
            appName: '', // Will be determined in next step
            sourceId: firstSourceId,
            ownerId: '', // Will be resolved later from source cache
        })
    }

    logger.info(`Built ${accessProfiles.length} valid access profiles (${groups.size - accessProfiles.length} discarded)`)

    return accessProfiles
}

/**
 * Group access profiles into applications based on definition settings
 */
function groupAccessProfilesIntoApplications(
    accessProfiles: AccessProfileData[],
    definition: AccessProfileDefinition
): ApplicationData[] {
    const appMap = new Map<string, ApplicationData>()

    for (const ap of accessProfiles) {
        let appName: string

        if (definition.groupAccessProfiles) {
            if (!definition.applicationExpression) {
                logger.error(`Access profile ${ap.name}: groupAccessProfiles is true but applicationExpression not defined`)
                continue
            }

            const appContext: Record<string, unknown> = {
                name: ap.name,
                definitionName: definition.name,
            }
            appContext.entitlement = definition.groupEntitlements ? ap.entitlements : ap.entitlements[0]
            if (definition.groupEntitlements) {
                appContext.entitlements = ap.entitlements
            }

            appName = evaluateVelocityExpression(definition.applicationExpression, appContext)

            if (!appName || appName === definition.applicationExpression) {
                logger.error(`Access profile ${ap.name}: application expression evaluated to empty`)
                continue
            }
        } else {
            appName = definition.name
        }

        ap.appName = appName

        let appData = appMap.get(appName)
        if (!appData) {
            appData = {
                name: appName,
                sourceId: ap.sourceId,
                accessProfileNames: [],
            }
            appMap.set(appName, appData)
        } else if (appData.sourceId !== ap.sourceId) {
            logger.error(`Application ${appName} has access profiles from multiple sources (${appData.sourceId} and ${ap.sourceId}), skipping AP ${ap.name}`)
            continue
        }

        appData.accessProfileNames.push(ap.name)
    }

    return Array.from(appMap.values())
}

/**
 * Validate that source consistency rules are met for the definition
 */
function validateSourceConsistency(
    accessProfiles: AccessProfileData[],
    definition: AccessProfileDefinition
): void {
    const sourceIds = new Set(accessProfiles.map(ap => ap.sourceId))

    if (sourceIds.size <= 1) {
        return
    }

    logger.info(`Definition ${definition.name} spans ${sourceIds.size} sources: ${Array.from(sourceIds).join(', ')}`)

    if (definition.createApplication) {
        const error = `Definition ${definition.name} has createApplication enabled but access profiles span multiple sources (${sourceIds.size} sources found). Applications can only be created for a single source. Either split this into separate definitions (one per source) or disable createApplication.`
        logger.error(error)
        throw new Error(error)
    } else {
        logger.warn(`Definition ${definition.name} creates access profiles across ${sourceIds.size} sources without creating applications. This is allowed but consider splitting into separate definitions for better organization.`)
    }
}
