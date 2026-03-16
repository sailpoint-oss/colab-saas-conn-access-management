import { logger } from '@sailpoint/connector-sdk'
import { EntitlementV2025, JsonPatchOperationV2025 } from 'sailpoint-api-client'
import { ISCClient } from '../isc-client'
import { Config } from '../model/config'
import {
    buildEntitlementVelocityContext,
    buildEntitlementRequestConfig,
    evaluateVelocityExpression,
    runWithConcurrency,
} from '../utils'

// Limit concurrent API calls to avoid overwhelming the API
const API_CONCURRENCY = 8

// ISC API limit for bulk entitlement updates
const BULK_UPDATE_CHUNK_SIZE = 50

/**
 * Chunks an array into smaller arrays of at most `size` elements.
 */
function chunk<T>(arr: T[], size: number): T[][] {
    const chunks: T[][] = []
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size))
    }
    return chunks
}

/**
 * Aggregates entitlements: uses the same selection logic as roles/access profiles
 * (query + entitlementExpression), then bulk-updates requestable/privileged and
 * optionally sets entitlement request config (approval) per entitlement.
 *
 * Flow:
 * 1. For each definition: fetch entitlements via query, filter by entitlementExpression.
 * 2. Bulk-update requestable/privileged (chunks of 50; API limit).
 * 3. If requireApproval + approverType: set entitlement request config per entitlement.
 *
 * - [Bulk update](https://developer.sailpoint.com/docs/api/v2025/update-entitlements-in-bulk):
 *   requestable, privileged (max 50 items per request).
 * - [Put entitlement request config](https://developer.sailpoint.com/docs/api/v2025/put-entitlement-request-config):
 *   approval schemes per entitlement.
 */
export async function aggregateEntitlements(config: Config, isc: ISCClient): Promise<void> {
    if (!config.entitlements?.length) {
        logger.debug('No entitlement definitions configured, skipping entitlement aggregation')
        return
    }

    for (const definition of config.entitlements) {
        logger.debug(`Processing entitlement definition: ${definition.name}`)
        const entitlements = await isc.listEntitlements(definition.query)
        logger.debug(`Found ${entitlements.length} entitlements for definition ${definition.name}`)

        // Filter: keep only entitlements where entitlementExpression evaluates to non-empty
        const selected: EntitlementV2025[] = []
        for (const entitlement of entitlements) {
            const context = buildEntitlementVelocityContext(entitlement, {
                definitionName: definition.name,
            })
            const name = evaluateVelocityExpression(definition.entitlementExpression, context)
            if (!name) {
                logger.info(
                    `Skipping entitlement ${entitlement.id}: expression evaluated to empty`
                )
                continue
            }
            selected.push(entitlement)
        }

        if (selected.length === 0) {
            logger.debug(`No entitlements selected for definition ${definition.name}`)
            continue
        }

        const entitlementIds = selected.map((e) => e.id!).filter(Boolean)

        // Build JSON patch for bulk update (requestable, privileged); API allows max 50 per request
        const jsonPatch: JsonPatchOperationV2025[] = []
        if (definition.requestable) {
            jsonPatch.push({
                op: 'replace',
                path: '/requestable',
                value: true as JsonPatchOperationV2025['value'],
            })
        }
        if (definition.privileged === true) {
            jsonPatch.push({
                op: 'replace',
                path: '/privileged',
                value: true as JsonPatchOperationV2025['value'],
            })
        }
        if (definition.privileged === false) {
            jsonPatch.push({
                op: 'replace',
                path: '/privileged',
                value: false as JsonPatchOperationV2025['value'],
            })
        }

        if (jsonPatch.length > 0) {
            // Process in chunks of 50 (bulk API limit)
            const chunks = chunk(entitlementIds, BULK_UPDATE_CHUNK_SIZE)
            for (let i = 0; i < chunks.length; i++) {
                try {
                    logger.debug(
                        `Bulk updating ${chunks[i].length} entitlements (chunk ${i + 1}/${chunks.length})`
                    )
                    await isc.updateEntitlementsInBulk(chunks[i], jsonPatch)
                } catch (error) {
                    logger.error(`Error bulk updating entitlements chunk ${i + 1}/${chunks.length} for definition ${definition.name}: ${error}`)
                    // Continue with remaining chunks instead of breaking
                }
            }
        }

        // Set entitlement request config (approval) per entitlement when requireApproval and approverType are defined
        if (definition.requestable && definition.requireApproval && definition.approverType) {
            const requestConfig = buildEntitlementRequestConfig(definition.approverType)
            const withIds = selected.filter((e): e is EntitlementV2025 & { id: string } => Boolean(e.id))
            await runWithConcurrency(withIds, API_CONCURRENCY, async (entitlement) => {
                try {
                    logger.debug(`Setting entitlement request config for ${entitlement.name} (${entitlement.id})`)
                    await isc.putEntitlementRequestConfig(entitlement.id, requestConfig)
                } catch (error) {
                    logger.error(`Error setting request config for entitlement ${entitlement.id}: ${error}`)
                }
            })
        }
    }
}
