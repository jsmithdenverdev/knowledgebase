## Backlog

- [ ] **Handle retained knowledge-base bucket collisions**: `KnowledgeBaseBucket` currently uses a fixed name (`knowledge-base-docs-<account>-<region>`) with `RemovalPolicy.RETAIN`. When the stack is destroyed, the bucket sticks around and `cdk deploy` fails on the next full create because the name already exists. Capture desired behavior (import existing bucket vs. auto-generated names vs. teardown helper) and implement a resilient pattern.
