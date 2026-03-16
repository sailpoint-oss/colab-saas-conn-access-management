import { EntitlementRefV2025, EntitlementV2025 } from 'sailpoint-api-client'
import { stringToMembership } from './membership-parser'
import { buildEntitlementVelocityContext, evaluateVelocityExpression } from './velocity'

export const entitlementToRef = (entitlement: EntitlementV2025): EntitlementRefV2025 => ({
    id: entitlement.id!,
    name: entitlement.name!,
    type: 'ENTITLEMENT',
})

export const areStringArraysEqual = (a?: string[], b?: string[]): boolean => {
    const arrA = (a ?? []).slice().sort()
    const arrB = (b ?? []).slice().sort()
    
    if (arrA.length !== arrB.length) return false
    return arrA.every((val, idx) => val === arrB[idx])
}

export { areEntitlementRefsEqual, areJsonEqual } from './comparison'
export { stringToMembership }
export { evaluateVelocityExpression } from './velocity'
export { buildEntitlementVelocityContext } from './velocity'
export {
    pushToGroupMap,
    buildApprovalSchemesConfig,
    buildEntitlementPatch,
    buildEntitlementRequestConfig,
    detectRequestableAndConfigChanges,
    shouldSkipUpdate,
} from './aggregation'
export type { EntitlementPatchOptions, ChangeDetectionResult } from './aggregation'
export { runWithConcurrency } from './concurrency'
export { searchWithFallback } from './search-fallback'
export type { SearchFallbackOptions } from './search-fallback'
