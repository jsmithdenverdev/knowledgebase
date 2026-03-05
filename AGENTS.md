# AGENTS.md

This file guides agentic coding agents working on this POC AWS application. The goal is to create a parameterized solution template that can be reused for future client implementations.

## Build, Lint, Test Commands

```bash
npm install              # Install dependencies
npm run build            # Compile TypeScript
npm run test             # Run all tests (Jest)
npm run test -- --testNamePattern="your test name"  # Run single test
npm run test -- --watch  # Watch mode
npm run lint             # ESLint check
npm run lint:fix         # Auto-fix lint issues
npm run format           # Prettier format
npm run format:check     # Check formatting
cdk synth                # Synthesize CloudFormation template
cdk deploy               # Deploy stack to AWS
cdk diff                 # Show changes before deploy
```

Precommit hooks (Husky) automatically run tests, lint, and format before allowing commits.

## Code Style Guidelines

### TypeScript & Types

- Enable strict mode, type all function parameters and return values
- Use interfaces for object shapes, types for unions/primitives
- AWS SDK v3: `import { ClientType } from '@aws-sdk/client-*'`
- CDK: `import * as cdk from 'aws-cdk-lib'`

### Imports

- Order: external libraries → internal modules → relative imports
- AWS SDK: import specific clients only, never entire package
- Example: `import { DynamoDBClient } from '@aws-sdk/client-dynamodb'`

### Formatting

- Let Prettier handle formatting (indents, quotes, etc.)
- Don't debate quote style - Prettier enforces consistency

### Naming Conventions

- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Functions/methods: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- AWS resources: `kebab-case` with environment prefix (e.g., `prod-chat-connection-table`)

### Error Handling

- Use Middy.js middleware for all Lambda handlers
- Custom error classes with status codes
- Middy's error handler for consistent JSON responses

### AWS SDK v3 Patterns

- Import specific clients, use `client.send()` with async/await
- Explicit types for all responses
- Dispose clients after use in Lambda handlers

### Lambda Patterns

- Use `Handler` type from `@types/aws-lambda`
- Middy middleware pipeline: logger → error handler → JSON body parser → CORS
- Extract business logic into separate testable functions
- Lambda Powertools Logger: structured logs, correlation IDs for tracing

### CDK Patterns

- Single stack for this POC
- Use CDK constructs, not raw CloudFormation
- Extract reusable logic into helper functions
- Environment variables for configuration
- Follow best practices: least privilege, consistent naming, tagging

### WebSockets for Streaming

- Use API Gateway WebSocket API for conversation streaming
- Lambda @connect/@disconnect/@default routes
- Connection management via DynamoDB
- Message routing: send responses back to connectionId

## Testing Guidelines

- Jest for unit tests, mock AWS SDK interactions
- CDK assertions (`@aws-cdk/assertions`) for CDK constructs
- Test Lambda handlers independently, mock dependencies
- Test files co-located: `src/handler.ts`, `src/handler.test.ts`
- Aim for >80% coverage on business logic
- Test naming: `describe("feature")` → `it("should do something")`

## Git & Branching Guidelines

- Main branch protected - all code via PR
- Feature branches from main
- CI/CD gates merge to main (tests must pass)
- Precommit hooks (Husky): run tests, lint, format before commit
- Never commit broken code - hooks enforce this
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`

## Agent Workflow Guidelines

- Collaborate with user, use `question` tool for decisions
- Think in templates/parameterization for future client reuse
- Keep POC minimal but extensible
- Document trade-offs when making architectural choices
- Follow the principle: code should be a starting template, not a one-off
