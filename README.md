[![Discourse Topics][discourse-shield]][discourse-url]
[![Issues][issues-shield]][issues-url]
[![Latest Releases][release-shield]][release-url]
[![Contributor Shield][contributor-shield]][contributors-url]

[discourse-shield]: https://img.shields.io/discourse/topics?label=Discuss%20This%20Tool&server=https%3A%2F%2Fdeveloper.sailpoint.com%2Fdiscuss
[discourse-url]: https://developer.sailpoint.com/discuss/tag/workflows
[issues-shield]: https://img.shields.io/github/issues/sailpoint-oss/repo-template?label=Issues
[issues-url]: https://github.com/sailpoint-oss/repo-template/issues
[release-shield]: https://img.shields.io/github/v/release/sailpoint-oss/repo-template?label=Current%20Release
[release-url]: https://github.com/sailpoint-oss/repo-template/releases
[contributor-shield]: https://img.shields.io/github/contributors/sailpoint-oss/repo-template?label=Contributors
[contributors-url]: https://github.com/sailpoint-oss/repo-template/graphs/contributors

# SailPoint Access Management Connector

[Discourse shield and badge links omitted for brevity]

This connector enables automated governance and lifecycle management of entitlements, access profiles, roles, and applications in SailPoint Identity Security Cloud (ISC). Using flexible query-based selection and Velocity expressions, you can bulk-update entitlement properties, create/update access profiles and roles, and establish approval workflows—all through configuration rather than manual processes.

## Overview

The Access Management connector provides three main capabilities:

### 1. Entitlement Management

Bulk-update entitlement properties across your sources:

-   Mark entitlements as requestable or privileged
-   Configure approval workflows per entitlement
-   Filter entitlements using API queries and Velocity expressions
-   Process entitlements in chunks (API limit: 50 per request)

### 2. Access Profile and Application Management

Automate access profile and application creation and lifecycle:

-   Query entitlements and group them into access profiles
-   Choose between 1:1 mapping (each entitlement = one access profile) or many:1 (multiple entitlements grouped by expression)
-   Create applications to organize and group access profiles
-   Distribute access profiles across multiple applications based on Velocity expressions
-   Configure requestability and approval workflows for both access profiles and applications
-   Support for both creation/update and deletion modes (deletes both access profiles and applications)

### 3. Role Management

Automate role creation with optional automatic assignment:

-   Query entitlements and group them into roles
-   Create multiple roles or a single consolidated role
-   Configure requestability and approval workflows
-   Set automatic role assignment using membership criteria
-   Support for both creation/update and deletion modes

## Prerequisites

-   Node.js (v14 or higher)
-   npm (v6 or higher)
-   SailPoint Identity Security Cloud tenant
-   Personal Access Token (PAT) with the following permissions:
    -   `idn:entitlement:read` - List and read entitlements
    -   `idn:entitlement:manage` - Bulk update entitlements
    -   `idn:entitlement-request-config:read` - Read entitlement request configs
    -   `idn:entitlement-request-config:update` - Update entitlement request configs
    -   `idn:access-profile:read` - List and read access profiles
    -   `idn:access-profile:manage` - Create, update, and delete access profiles
    -   `idn:role:read` - List and read roles
    -   `idn:role:manage` - Create, update, and delete roles
    -   `idn:application:read` - List and read applications
    -   `idn:application:manage` - Create, update, and delete applications
    -   `idn:source:read` - Read source configurations
    -   `idn:public-identities-config:read` - Test connection (optional)

## Installation

1.  Clone this repository

    ```bash
    git clone <repo url>
    ```

2.  Install dependencies:

    ```bash
    npm install
    ```

3.  Build the connector:

    ```bash
    npm run build
    ```

4.  Package the connector for deployment:

    ```bash
    npm run pack-zip
    ```

## Configuration

The connector configuration is divided into several sections in the ISC UI:

### Connection Details

-   **Identity Security Cloud API URL**: Your ISC tenant's API URL (e.g., `https://tenant.api.identitynow.com`)
-   **Personal Access Token ID**: The Client ID from your PAT
-   **Personal Access Token Secret**: The Client Secret from your PAT

### Entitlement Definitions

Each entitlement definition allows you to bulk-update entitlement properties:

#### Selection Configuration

-   **Definition Name**: Descriptive name for identification and logging
-   **Entitlement Query**: List Entitlements API `filters` query (SCIM-like syntax, e.g., `source.name eq "Active Directory" and name sw "Admin"`)
-   **Entitlement Expression**: Velocity expression to filter selected entitlements
    -   Return any non-empty value to include the entitlement
    -   Return empty/null to exclude
    -   Context: `$entitlement` (entire object)
    -   Top-level aliases are also available for compatibility (e.g., `$name`, `$value`, `$attribute`)
    -   `$definitionName` is available and equals this definition's configuration name
    -   Example: `#if($name.contains('Admin'))include#end`

#### Update Configuration

-   **Privileged**: Mark entitlements as privileged (bulk update API)
-   **Requestable**: Make entitlements requestable (bulk update API)
-   **Require Approval**: Enable approval workflow (entitlement request config API)
-   **Approver Type**: Choose approver (ENTITLEMENT_OWNER, SOURCE_OWNER, or MANAGER)

**Note**: Bulk updates process in chunks of 50 entitlements (API limit). Approval configuration is applied per entitlement with controlled concurrency (8 concurrent requests).

### Access Profile Definitions

Each access profile definition creates or manages access profiles from entitlements:

#### Selection Configuration

-   **Access Profile Configuration Name**: Descriptive name for this definition
-   **Entitlement Query**: List Entitlements API `filters` query (SCIM-like syntax, e.g., `source.name eq "Workday" and attribute eq "Department"`)
-   **Entitlement Expression**: Velocity expression that determines access profile names
    -   Return empty to exclude entitlement
    -   When `groupEntitlements=true`: entitlements with the same result are grouped into one access profile
    -   When `groupEntitlements=false`: each entitlement creates one access profile (1:1 mapping)
    -   Context: `$entitlement` (entire object)
    -   Top-level aliases are also available for compatibility (e.g., `$name`, `$value`, `$attribute`)
    -   `$definitionName` is available and equals this definition's configuration name
    -   Example: `$attribute` or `${source.name}_${attribute}`

#### Access Profile Configuration

-   **Delete mode**: DELETION MODE - deletes both access profiles and applications instead of creating/updating (use with caution)
-   **Group entitlements into access profiles**:
    -   Enabled: Multiple entitlements → one access profile (many:1)
    -   Disabled: One entitlement → one access profile (1:1)
-   **Requestable**: Make access profiles requestable
-   **Require Approval**: Enable approval workflow
-   **Approver Type**: Choose approver (APP_OWNER, OWNER, SOURCE_OWNER, or MANAGER)
-   **Create application(s)**: Create ISC applications to group access profiles
-   **Group access profiles into multiple applications**:
    -   Enabled: Access profiles distributed across multiple applications based on expression
    -   Disabled: All access profiles go into one application (named after definition)
-   **Application name expression**: Velocity expression to name applications
    -   Evaluated only when `createApplication=true` and `groupAccessProfiles=true`
    -   Context: `$name` (access profile name)
    -   `$definitionName` is available and equals this definition's configuration name
    -   If `groupEntitlements=false`: `$entitlement` (single entitlement object)
    -   If `groupEntitlements=true`: `$entitlement` and `$entitlements` (both are arrays of entitlement objects)
    -   Example: `${name}_App` or `$entitlement.source.name`

### Role Definitions

Each role definition creates or manages roles from entitlements:

#### Selection Configuration

-   **Role Group Name**: Name for this definition (also the actual role name when `groupEntitlements=false`)
-   **Entitlement Query**: List Entitlements API `filters` query (SCIM-like syntax, e.g., `source.name eq "SAP" and privileged eq true`)
-   **Entitlement Expression**: Velocity expression for filtering and naming
    -   Return empty to exclude entitlement
    -   When `groupEntitlements=true`: result becomes role name, entitlements with same result are grouped
    -   Context: `$entitlement` (entire object)
    -   Top-level aliases are also available for compatibility (e.g., `$name`, `$value`, `$attribute`)
    -   `$definitionName` is available and equals this definition's configuration name
    -   Example: `$attribute` or `${source.name}_${attribute}`

#### Role Configuration

-   **Delete roles**: DELETION MODE - deletes roles instead of creating/updating (use with caution)
-   **Group entitlements by expression**:
    -   Enabled: Create multiple roles by grouping entitlements with same expression result (many:1)
    -   Disabled: Create one role containing all selected entitlements (all:1)
-   **Requestable**: Make roles requestable
-   **Require Approval**: Enable approval workflow
-   **Approver Type**: Choose approver (APP_OWNER, OWNER, SOURCE_OWNER, or MANAGER)
-   **Automatic Assignment**: Automatically assign roles when membership criteria are met
-   **Assignment Definition**: Membership criteria using Velocity template syntax
    -   Can reference identity attributes and use logical operators
    -   See [this guide](https://github.com/yannick-beot-sp/vscode-sailpoint-identitynow?tab=readme-ov-file#roles) for format details
    -   Variables: `$name` (role name), `$definitionName` (definition configuration name), plus `$entitlement` (single entitlement) when `groupEntitlements=false`, or `$entitlements` (array) when `groupEntitlements=true`

## Development

### Available Scripts

-   `npm run clean` - Clean the dist directory
-   `npm run build` - Build the connector using ncc
-   `npm run dev` - Run the connector in development mode
-   `npm run debug` - Run the connector in debug mode
-   `npm run prettier` - Format code using Prettier
-   `npm run pack-zip` - Package the connector for deployment

### Building

To build the connector:

```bash
npm run build
```

The build process uses `@vercel/ncc` to create a single-file bundle in the `dist` directory.

### Testing

To test the connection:

```bash
npm run dev
```

## Deployment

1. Build the connector:

```bash
npm run build
```

2. Package the connector:

```bash
npm run pack-zip
```

3. Upload the generated zip file to your SailPoint Identity Security Cloud tenant

## Features

### Entitlement Management

-   Query-based entitlement selection using List Entitlements API (`/v2025/entitlements`) filters
-   Velocity expression filtering for fine-grained control
-   Bulk update of requestable and privileged flags (50 entitlements per API call)
-   Per-entitlement approval workflow configuration
-   Controlled concurrency for API calls (8 concurrent requests)

### Access Profile and Application Management

-   Automated access profile creation based on entitlement queries
-   Flexible access profile grouping strategies:
    -   1:1 mapping: One entitlement → one access profile
    -   Many:1 mapping: Multiple entitlements → one access profile (grouped by expression)
-   Automated application creation and management
-   Flexible application grouping strategies:
    -   Single application: All access profiles → one application
    -   Multiple applications: Access profiles distributed across applications (grouped by expression)
-   Customizable naming using Velocity expressions for both access profiles and applications
-   Requestable access profiles with configurable approval workflows
-   Support for multiple approver types (Application Owner, Owner, Source Owner, Manager)
-   Intelligent update detection (only updates when changes detected)
-   Unified deletion mode (deletes both access profiles and their applications)

### Role Management

-   Automated role creation based on entitlement queries
-   Flexible grouping strategies:
    -   All:1 mapping: All entitlements → one role
    -   Many:1 mapping: Multiple entitlements → multiple roles (grouped by expression)
-   Customizable naming using Velocity expressions
-   Requestable roles with configurable approval workflows
-   Automatic role assignment based on membership criteria
-   Support for multiple approver types (Application Owner, Owner, Source Owner, Manager)
-   Pre-fetching via Search API to minimize API calls
-   Intelligent update detection (only updates when changes detected)
-   Deletion mode for cleanup operations

### General Features

-   Comprehensive error handling and logging
-   Velocity template support for dynamic naming and filtering
-   Source-aware operations (owner resolution, validation)
-   Controlled concurrency (8 concurrent API operations)
-   Smart update detection to avoid unnecessary API calls
-   Integration with ISC V2025 APIs
-   Debug logging support

## Velocity Template Variables

Velocity expressions are used throughout the connector for filtering and naming. The available context variables depend on the operation:

### `entitlementExpression` (Entitlements, Access Profiles, Roles)

Available variables:

-   `$entitlement` - full entitlement object (preferred form)
-   Top-level entitlement aliases (for compatibility): `$id`, `$name`, `$value`, `$attribute`, `$description`, `$privileged`, `$requestable`, `$source`
-   `$definitionName` - configuration definition name (`name` field in connector config)
-   Nested fields are available via object access (for example: `$entitlement.source.name`, `$source.name`)

### `applicationExpression` (Access Profiles)

Evaluated only when `createApplication=true` and `groupAccessProfiles=true`.

Available variables:

-   `$name` - access profile name (this is the value produced by `entitlementExpression`, not the configuration definition name)
-   `$definitionName` - configuration definition name (`name` field in connector config)
-   If `groupEntitlements=false`: `$entitlement` (single entitlement object)
-   If `groupEntitlements=true`: `$entitlement` and `$entitlements` (both are arrays of entitlement objects)

### `assignmentDefinition` (Roles)

Available variables:

-   `$name` - role name
-   `$definitionName` - configuration definition name (`name` field in connector config)
-   If `groupEntitlements=false`: `$entitlement` (single entitlement object)
-   If `groupEntitlements=true`: `$entitlements` (array of entitlement objects)
-   Identity attributes can be referenced (see [membership criteria guide](https://github.com/yannick-beot-sp/vscode-sailpoint-identitynow?tab=readme-ov-file#roles))

### Expression Examples

**Filter entitlements by name pattern:**

```velocity
#if($name.contains('Admin'))$name#end
```

**Create access profile name from attribute:**

```velocity
$attribute
```

**Create role name from source and attribute:**

```velocity
${source.name}_${attribute}
```

**Create application name from access profile:**

```velocity
${name}_Application
```

**Create application name from configuration group name:**

```velocity
${definitionName}_Application
```

**Filter privileged entitlements only:**

```velocity
#if($privileged)include#end
```

## Dependencies

-   @sailpoint/connector-sdk: ^1.1.22
-   form-data: ^4.0.2
-   sailpoint-api-client: ^1.6.0
-   velocityjs: ^2.1.5

### Development Dependencies

-   @vercel/ncc: ^0.34.0
-   cross-env: 7.0.3
-   prettier: ^2.3.2
-   shx: ^0.3.3
-   typescript: ^5.3.3
-   typescript-eslint: ^8.2.0

## Project Structure

```
access-management/
├── src/
│   ├── data/
│   │   └── constants.ts                # Constants and configuration values
│   ├── model/
│   │   ├── config.ts                   # TypeScript interfaces for configuration
│   │   └── propertyDefinitions.ts      # Property definition types
│   ├── operations/
│   │   ├── entitlement-aggregation.ts  # Entitlement bulk update logic
│   │   ├── access-profile-aggregation.ts # Access profile & application management
│   │   ├── role-aggregation.ts         # Role creation/update/delete
│   │   └── index.ts                    # Operations exports
│   ├── utils/
│   │   ├── aggregation.ts              # Shared aggregation utilities
│   │   ├── comparison.ts               # Change detection utilities
│   │   ├── concurrency.ts              # Concurrency control
│   │   ├── membership-parser.ts        # Role membership criteria parser
│   │   ├── throttle.ts                 # Rate limiting utilities
│   │   ├── velocity.ts                 # Velocity template evaluation
│   │   └── index.ts                    # Utility exports
│   ├── axios.ts                        # Axios client configuration
│   ├── index.ts                        # Main connector entry point
│   └── isc-client.ts                   # ISC API client wrapper
├── connector-spec.json                 # Connector specification and UI config
├── package.json                        # Dependencies and scripts
├── tsconfig.json                       # TypeScript configuration
└── README.md                           # This file
```

## How It Works

### Entitlement Aggregation Flow

1. For each entitlement definition:
    - Query entitlements using the configured filter
    - Evaluate `entitlementExpression` for each entitlement
    - Filter out entitlements where expression returns empty/null
2. If requestable or privileged flags are configured:
    - Build JSON patch operations
    - Update entitlements in chunks of 50 (API limit)
3. If approval is required:
    - Build entitlement request config
    - Apply per entitlement with controlled concurrency (8 concurrent)

### Access Profile and Application Aggregation Flow

**Creation/Update Mode:**

1. For each access profile definition:
    - Query entitlements using the configured filter
    - Evaluate `entitlementExpression` for each entitlement
    - Filter out entitlements where expression returns empty/null
2. Group entitlements into access profiles:
    - If `groupEntitlements=false`: 1:1 mapping (overlapping entitlements discarded)
    - If `groupEntitlements=true`: Many:1 mapping (group by expression result)
3. Validate source consistency across all entitlements
4. Process access profiles:
    - Pre-fetch source information (for owner ID)
    - Check if access profile exists
    - Detect changes (entitlements, requestable, approval config)
    - Create new or update existing access profile via PATCH
5. Process applications (if `createApplication=true`):
    - Group access profiles by `applicationExpression` result (if `groupAccessProfiles=true`)
    - Or create single application with all access profiles (if `groupAccessProfiles=false`)
    - For each application:
        - Check if application exists
        - Detect changes (name, assigned access profiles)
        - Create new or update existing application via PATCH
        - Assign access profiles to the application

**Deletion Mode** (when `deleteMode=true`):

1. Query entitlements to identify affected sources
2. Determine which access profiles and applications WOULD have been created based on current configuration
3. Find all existing access profiles in those sources
4. Find all existing applications in those sources
5. **Critical step: Remove access profiles from ALL applications that reference them**
   - Access profiles cannot be deleted if they're still assigned to any application
   - This includes applications not managed by this definition
6. Delete applications created by this definition (if `createApplication=true`)
7. Delete access profiles created by this definition
8. Only objects matching the naming patterns from this definition are deleted

### Role Aggregation Flow

**Creation/Update Mode:**

1. Resolve the connector's source (by `spConnectorInstanceId`)
2. For each role definition:
    - Query entitlements using the configured filter
    - Evaluate `entitlementExpression` for each entitlement
    - Filter out entitlements where expression returns empty/null
3. Group entitlements:
    - If `groupEntitlements=false`: All:1 mapping (one role with all entitlements)
    - If `groupEntitlements=true`: Many:1 mapping (group by expression result)
4. Pre-fetch existing roles via Search API (using entitlement IDs for efficiency)
5. For each role:
    - Build role properties (entitlements, requestable, approval, membership)
    - If `automaticAssignment=true`: parse assignment definition and build membership criteria
    - Detect changes (entitlements, requestable, approval, membership)
    - Create new or update existing role via PATCH
6. Process with controlled concurrency (8 concurrent API calls)

**Deletion Mode** (when `deleteStaleRoles=true`):

1. Query entitlements to collect all entitlement IDs
2. Search for existing roles containing those entitlements
3. Delete roles previously created by this definition

## API Endpoints Used

### V3 APIs (via sailpoint-api-client)

-   `GET /v3/entitlements` - List entitlements with filters
-   `GET /v3/sources` - List sources
-   `GET /v3/access-profiles` - List access profiles
-   `POST /v3/access-profiles` - Create access profiles
-   `PATCH /v3/access-profiles/{id}` - Update access profiles
-   `DELETE /v3/access-profiles/{id}` - Delete access profiles
-   `GET /v3/roles` - List roles
-   `POST /v3/roles` - Create roles
-   `PATCH /v3/roles/{id}` - Update roles
-   `DELETE /v3/roles/{id}` - Delete roles
-   `POST /v3/search` - Search for roles by entitlements

### V2025 APIs (via sailpoint-api-client)

-   `PATCH /v2025/entitlements` - Bulk update entitlements (max 50 per request)
-   `PUT /v2025/entitlement-request-config/{id}` - Set entitlement request config
-   `GET /v2025/applications` - List applications
-   `POST /v2025/applications` - Create applications
-   `PATCH /v2025/applications/{id}` - Update applications
-   `DELETE /v2025/applications/{id}` - Delete applications

## Performance Considerations

-   **Bulk Updates**: Entitlement updates are processed in chunks of 50 (API limit)
-   **Concurrency**: API operations use controlled concurrency (8 concurrent requests)
-   **Pre-fetching**: Roles are pre-fetched via Search API to minimize round-trips
-   **Smart Updates**: Changes are detected before updates to avoid unnecessary API calls
-   **Source Caching**: Sources are cached during access profile processing to reduce API calls

## Troubleshooting

### Enable Debug Logging

The connector includes debug logging that can be enabled in the source configuration:

1. In ISC, navigate to your Access Management source
2. Enable "Show Debug Logging" option
3. Run an aggregation
4. Check aggregation logs for detailed operation flow

### Common Issues

**Issue**: Entitlements not being updated

-   Check the `entitlementExpression` - it might be filtering out entitlements
-   Verify the query syntax matches List Entitlements API `filters` format
-   Check debug logs for expression evaluation results

**Issue**: Access profiles/roles not created

-   Verify source consistency (all entitlements must be from the same source)
-   Check that `entitlementExpression` returns non-empty values
-   Ensure PAT has required permissions
-   Review debug logs for API errors

**Issue**: Deletion mode not working / HTTP 400 errors when deleting access profiles

-   **Root cause**: Access profiles cannot be deleted if they're still assigned to any application
-   **Solution**: The connector now removes access profiles from ALL applications (including those not managed by this definition) before attempting deletion
-   Verify the deletion toggle is enabled
-   Check that access profiles/roles were created by this connector
-   Only objects matching the source and naming pattern will be deleted
-   Review debug logs for detailed deletion flow and any errors

**Issue**: Approval workflows not applying

-   Ensure `requireApproval=true` and `approverType` is set
-   For entitlements: approval is set per entitlement via request config API
-   For access profiles/roles: approval is set via the requestability configuration
-   Check debug logs for API errors

## Attribution

-   Automatic role assignment feature contributed by [Yannick Béot](https://github.com/yannick-beot-sp)

## Project Structure

```
access-management/
├── src/
│   ├── data/
│   │   └── constants.ts
│   ├── model/
│   │   ├── config.ts
│   │   └── propertyDefinitions.ts
│   ├── utils/
│   │   ├── index.ts
│   │   └── membership-parser.ts
│   ├── index.ts
│   └── isc-client.ts
├── connector-spec.json
├── package.json
├── tsconfig.json
└── README.md
```

[New to the CoLab? Click here »](https://developer.sailpoint.com/discuss/t/about-the-sailpoint-developer-community-colab/11230)

<!-- CONTRIBUTING -->

## Contributing

Contributions are what make the open source community such an amazing place to learn, inspire, and create. Any contributions you make are **greatly appreciated**.

If you have a suggestion that would make this better, please fork the repo and create a pull request. You can also simply open an issue with the tag `enhancement`.
Don't forget to give the project a star! Thanks again!

1. Fork the Project
2. Create your Feature Branch (`git checkout -b feature/AmazingFeature`)
3. Commit your Changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the Branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

<!-- LICENSE -->

## License

Distributed under the MIT License. See `LICENSE.txt` for more information.

<!-- CONTACT -->

## Discuss

[Click Here](https://developer.sailpoint.com/dicuss/tag/{tagName}) to discuss this tool with other users.
