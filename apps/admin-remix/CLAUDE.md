# Admin Remix App - Context for Claude

## Overview

The **Admin Remix** app is the web-based user interface for Starkeeper. Built with Remix and Mantine UI, it provides a complete workflow for managing CloudFormation deployments across AWS accounts.

**Location**: `apps/admin-remix`

## Tech Stack

- **Framework**: [Remix](https://remix.run/) v2.13.1 (React-based full-stack framework)
- **UI Library**: [Mantine](https://mantine.dev/) v7.17.8 (React components library)
- **Styling**: Emotion CSS-in-JS
- **Type Safety**: TypeScript + Zod validation
- **Build Tool**: Vite
- **Data Tables**: TanStack React Table v8

## Architecture

### Remix Patterns Used

1. **Server-Side Rendering (SSR)**: All routes render on server first
2. **Loaders**: Fetch data on server before rendering
3. **Actions**: Handle form submissions and mutations
4. **Progressive Enhancement**: Works without JavaScript (forms)
5. **File-based Routing**: Route structure matches URL structure

### Directory Structure

```
apps/admin-remix/
├── app/
│   ├── routes/              # File-based routing
│   │   ├── _index.tsx       # Dashboard (/)
│   │   ├── settings.aws.tsx # AWS connection wizard
│   │   ├── deployments._index.tsx        # Deployment list
│   │   ├── deployments.new.tsx           # Create deployment
│   │   ├── deployments.$id.tsx           # View plan
│   │   └── deployments.$id_.status.tsx   # Deployment status
│   ├── root.tsx             # Root layout
│   └── entry.server.tsx     # Server entry point
├── public/                  # Static assets
├── package.json
└── vite.config.ts
```

## Routes

### Authentication Routes

#### `/auth/register` - Create Account
**Purpose**: Create a new user and workspace (customer).
- Creates `users` + `customer_memberships`
- Sets password (argon2id)
- Starts session

#### `/auth/login` - Sign In
**Purpose**: Email/password login.
- Prompts for 2FA if enabled
- Creates DB-backed session

#### `/auth/magic-link` - Email Login Link (Optional)
**Purpose**: Send a one-time login link via email.
- Disabled if `RESEND_API_KEY`/`EMAIL_FROM` are not set

#### `/auth/2fa` - Two-Factor Challenge
**Purpose**: Verify TOTP or recovery code during sign-in.

#### `/auth/2fa/setup` - Enable Two-Factor
**Purpose**: Configure TOTP and generate recovery codes.

#### `/auth/invite` - Invite Teammate
**Purpose**: Send an invite link to join an existing workspace.
- Owner/admin only
- Disabled if email is not configured

#### `/auth/invite/accept` - Accept Invite
**Purpose**: Accept an invitation link and join a workspace.
- Prompts to set a password if the user is new

#### `/auth/set-password` - Set Password (Invite)
**Purpose**: Create a password for invited users.

#### `/auth/logout` - Sign Out
**Purpose**: Revoke current session and clear cookie.

### Auth Data Model

Tables (Postgres):
- `users` - Auth identities (email + verification timestamp)
- `customer_memberships` - User ↔ customer mapping with role (`owner`, `admin`, `member`)
- `auth_passwords` - Argon2id password hashes
- `auth_sessions` - DB-backed sessions with expiry + revocation
- `auth_magic_links` - One-time login links (optional, email required)
- `auth_totp` - Encrypted TOTP secrets
- `auth_recovery_codes` - Hashed recovery codes
- `auth_invitations` - Invite tokens for onboarding users to existing customers

Auth flow summary:
- Session cookie stores `sessionId`; loaders/actions resolve session → user → customer.
- Email features are disabled when `RESEND_API_KEY`/`EMAIL_FROM` are not set.

### `/` - Dashboard
**File**: `_index.tsx`
- Simple landing page with navigation
- Links to AWS settings and deployments

### `/settings/aws` - AWS Connection Wizard
**File**: `settings.aws.tsx`

**Purpose**: Multi-step wizard to connect AWS accounts

**Steps**:
1. **Account Information**
   - AWS Account ID
   - Stack prefix (e.g., `myapp`)
   - Allowed regions (optional)
   - External ID (auto-generated UUID)

2. **Bootstrap Template Generation**
   - Generates CloudFormation template
   - Creates IAM roles (Access, Execution, Permission Boundary)
   - Provides Quick Create link for AWS Console

3. **Complete Connection**
   - User deploys bootstrap stack in AWS
   - Copies outputs back to Starkeeper
   - Saves connection in database

**Key Functions**:
- `loader()`: Checks if AWS settings exist, generates External ID
- `action()`: Handles form submissions for each step
- State management via URL search params (`?step=1`, `?step=2`, etc.)

**Dependencies**:
- `@starkeeper/core`: `generateBootstrapTemplate()`, `getQuickCreateUrl()`
- `@starkeeper/db`: `AwsSettingsRepository`

### `/deployments` - Deployment List
**File**: `deployments._index.tsx`

**Purpose**: Shows all deployments with status

**Features**:
- Table view with stack name, region, environment, status
- Status badges with color coding (green/blue/red)
- "View Plan" and "View Status" buttons
- Delete button with confirmation modal
- Shows latest deployment status (not plan status)

**Loader**:
- Fetches all plans for customer
- Joins with latest deployment for each plan
- Returns `{ plans: plansWithDeployments }`

**Action**:
- `DELETE` method: Deletes plan and associated deployments
- Redirects to `/deployments`

**UI Components**:
- Mantine Table (striped, highlight on hover)
- Status badges with `getStatusColor()` helper
- Delete modal with confirmation

### `/deployments/new` - Create Deployment
**File**: `deployments.new.tsx`

**Purpose**: Form to create new deployment

**Fields**:
1. **Template** - Select from available templates
2. **Environment** - dev/staging/prod
3. **AWS Region** - us-east-1, us-west-2, etc.

**Workflow**:
1. User submits form
2. Generate CloudFormation template from selected type
3. Upload template to S3
4. Store template metadata in database
5. Create plan record
6. Create CloudFormation change set
7. Update plan with change set details
8. Redirect to plan review page

**Key Features**:
- Loading state on submit button ("Creating Deployment...")
- Validates AWS connection exists
- Shows error alerts for failures
- Uses `useNavigation()` for loading state

**Dependencies**:
- Template generation: `generateTemplate()`
- S3 upload: `uploadTemplate()`
- AWS provider: `planDeployment()`

### `/deployments/:id` - Plan Review
**File**: `deployments.$id.tsx`

**Purpose**: Review CloudFormation change set before deploying

**Features**:
- Shows plan details (stack name, region, environment)
- Displays change set status
- Lists all resource changes (Add/Modify/Remove)
- Color-coded changes (green/yellow/red)
- "Approve & Deploy" button

**Workflow**:
1. Load plan from database
2. Fetch change set details from AWS
3. Display changes in table
4. On approve: Execute change set
5. Create deployment record
6. Redirect to status page

**Change Set States**:
- `READY`: Can be executed
- `CREATING`: Still being created (shows loading)
- `FAILED`: Creation failed (shows error)

**Loader**:
- Fetches plan by ID
- Gets change set details from AWS Provider
- Transforms changes for display

**Action**:
- Executes approved change set
- Creates deployment record in database
- Updates plan status to EXECUTING

### `/deployments/:id/status` - Deployment Status
**File**: `deployments.$id_.status.tsx`

**Purpose**: Monitor CloudFormation deployment progress

**Features**:
- Real-time stack events (auto-refresh every 5 seconds)
- Deployment status badges (IN_PROGRESS/COMPLETED/FAILED)
- Stack outputs display (URLs, resource IDs)
- Event timeline with color coding
- Delete deployment button
- Auto-updates deployment status when complete

**Auto-Refresh**:
```typescript
useEffect(() => {
  if (deployment?.status === "IN_PROGRESS") {
    const interval = setInterval(() => {
      revalidator.revalidate();
    }, 5000);
    return () => clearInterval(interval);
  }
}, [deployment?.status, revalidator]);
```

**Loader**:
- Fetches plan and latest deployment
- Gets CloudFormation stack events
- Gets stack outputs (if completed)
- Checks stack status and updates deployment record if terminal state reached
- Maps CloudFormation status to deployment status

**Stack Outputs**:
- Displayed in "Application Outputs" section
- URLs rendered as clickable buttons
- Other values shown as code blocks
- Only shown when deployment is COMPLETED

**Action**:
- `DELETE` method: Deletes plan
- Redirects to deployments list

**Route Naming**:
- Uses `$id_.status.tsx` (underscore before period) to prevent routing conflicts
- Without underscore, `/deployments/$id.tsx` would match first

## Key Patterns

### Loader Pattern
```typescript
export async function loader({ request, params }: LoaderFunctionArgs) {
  // Server-side data fetching
  const data = await fetchData();
  return json({ data });
}

export default function MyRoute() {
  const { data } = useLoaderData<typeof loader>();
  // Render with data
}
```

### Action Pattern
```typescript
export async function action({ request }: ActionFunctionArgs) {
  const formData = await request.formData();
  const field = formData.get("field");

  // Process mutation
  await updateData(field);

  return redirect("/success");
  // or return json({ error: "Failed" });
}
```

### Form with Loading State
```typescript
const navigation = useNavigation();
const isSubmitting = navigation.state === "submitting";

<Form method="post">
  <Button type="submit" loading={isSubmitting}>
    {isSubmitting ? "Saving..." : "Save"}
  </Button>
</Form>
```

### Delete with Confirmation
```typescript
const fetcher = useFetcher();
const [modalOpen, setModalOpen] = useState(false);

const handleDelete = () => {
  fetcher.submit({}, { method: "delete" });
  setModalOpen(false);
};

<Modal opened={modalOpen} onClose={() => setModalOpen(false)}>
  <Button onClick={handleDelete}>Confirm Delete</Button>
</Modal>
```

## Mantine UI Components Used

### Layout
- `Container`: Max-width centered content
- `Stack`: Vertical spacing
- `Group`: Horizontal grouping with gap
- `Paper`: Card-like container with border

### Forms
- `Select`: Dropdown selection
- `Button`: Primary/secondary actions
- `Form` (Remix): Progressive enhancement

### Display
- `Table`: Data tables with sorting
- `Badge`: Status indicators
- `Code`: Inline code display
- `Alert`: Contextual messages
- `Timeline`: Event history
- `Modal`: Dialogs and confirmations
- `Loader`: Spinner for loading states

### Typography
- `Title`: Headings (order 1-6)
- `Text`: Body text with size/weight options

## State Management

### URL-Based State
- No global state management library needed
- Remix uses URL for navigation state
- Search params for wizard steps: `?step=2`
- Route params for resource IDs: `/deployments/:id`

### Form State
- Controlled by Remix's `<Form>` component
- `useNavigation()` for submit state
- `useActionData()` for validation errors

### Optimistic UI
- `useFetcher()` for non-navigation mutations
- Allows delete/update without full page refresh

## Data Flow

### Create Deployment Flow
```
User fills form
    ↓
Action: generateTemplate()
    ↓
uploadTemplate() to S3
    ↓
Save template to DB
    ↓
Create plan record
    ↓
awsProvider.planDeployment()
    ↓
Update plan with change set ID
    ↓
Redirect to /deployments/:id
```

### Deploy Flow
```
User clicks "Approve & Deploy"
    ↓
Action: executeChangeSet()
    ↓
Create deployment record
    ↓
Update plan status
    ↓
Redirect to /deployments/:id/status
    ↓
Auto-refresh polls stack status
    ↓
Update deployment when complete
```

## Environment Variables

Required for development:
```bash
DATABASE_URL=postgresql://craig@localhost:5432/starkeeper
ARTIFACTS_BUCKET=starkeeper-dev-artifactsbucketbucket-wxkevsob
AWS_ACCOUNT_ID=538090423355
```

Access in code:
```typescript
const bucket = process.env.ARTIFACTS_BUCKET;
```

## Running Locally

```bash
# From project root
npm run dev --workspace=@starkeeper/admin-remix

# Or with dotenv
npx dotenv-cli -e .env -- npm run dev --workspace=@starkeeper/admin-remix

# Access at http://localhost:5173
```

## Common Tasks

### Add a New Route
1. Create file in `app/routes/`: `my-route.tsx`
2. Export loader and/or action
3. Export default component
4. URL will be `/my-route`

### Add a New Form Field
1. Add to form JSX
2. Read in action: `formData.get("fieldName")`
3. Validate with Zod if needed
4. Return errors via `json({ error })`

### Show Loading State
```typescript
const navigation = useNavigation();
const isLoading = navigation.state !== "idle";
```

### Display Stack Outputs
Outputs are automatically fetched in status page loader. To display:
```typescript
{outputs?.map(output => (
  <div>
    <Text>{output.outputKey}</Text>
    {output.outputValue.startsWith('http') ? (
      <Button component="a" href={output.outputValue}>
        {output.outputValue}
      </Button>
    ) : (
      <Code>{output.outputValue}</Code>
    )}
  </div>
))}
```

## Known Issues

### Route Naming
- Nested routes require underscore before period
- ✅ Correct: `deployments.$id_.status.tsx`
- ❌ Wrong: `deployments.$id.status.tsx` (would be shadowed by `$id.tsx`)

### Auto-Refresh
- Only works when deployment status is IN_PROGRESS
- Stops refreshing when status becomes COMPLETED or FAILED
- Uses `revalidator.revalidate()` to trigger loader

### Form Validation
- Currently no client-side validation
- Server-side validation in actions
- Errors shown via Alert components

## Testing Notes

- No tests currently implemented
- Manual testing via UI workflow
- Database state checked with psql

## Future Enhancements

- [ ] Client-side form validation with Zod
- [ ] Real-time updates with WebSockets (instead of polling)
- [ ] Deployment scheduling
- [ ] Multi-tenant support with org switching
- [ ] Cost estimation before deployment
- [ ] Deployment history pagination
- [ ] Search and filter deployments
- [ ] Dark mode support
- [ ] Mobile responsive improvements

## Dependencies

### Internal Packages
- `@starkeeper/core`: Domain logic and templates
- `@starkeeper/db`: Database repositories
- `@starkeeper/providers`: AWS provider
- `@starkeeper/shared`: Types and schemas

### External Libraries
- `@remix-run/*`: Framework
- `@mantine/*`: UI components
- `@emotion/*`: CSS-in-JS
- `zod`: Runtime validation
- `react` / `react-dom`: UI library

## Troubleshooting

### "Module not found" errors
```bash
# Rebuild packages
npm run build

# Or in watch mode
npm run dev
```

### Styles not loading
- Mantine requires Emotion setup in `root.tsx`
- Check `MantineProvider` is wrapping app

### Forms not submitting
- Ensure `<Form method="post">` (capital F for Remix)
- Check action is exported
- Verify field names match in action

### Auto-refresh not working
- Check deployment status is "IN_PROGRESS"
- Verify `useEffect` dependencies array
- Check browser console for errors

## Key Files Reference

- **Root layout**: `app/root.tsx` - Mantine setup, HTML structure
- **Route entry**: `app/entry.server.tsx` - SSR configuration
- **Vite config**: `vite.config.ts` - Build configuration
- **Package config**: `package.json` - Dependencies and scripts
