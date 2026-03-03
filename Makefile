STACK ?= KnowledgeBaseStack
REGION ?= us-east-1
AWS := aws --region $(REGION)
SINCE ?= 1h
DOC_KEY ?= documents/2025-nfl-rulebook-final.pdf
DATA_SOURCE_NAME ?= documents-data-source

.PHONY: logs-ingest log-groups list-kb list-datasources list-ingestion-jobs describe-ingestion-job head-doc doc-tags copy-doc stack-status

ACCOUNT := $(shell $(AWS) sts get-caller-identity --query "Account" --output text)
BUCKET := knowledge-base-docs-$(ACCOUNT)-$(REGION)
KB_NAME := knowledge-base-$(ACCOUNT)-$(REGION)

define load_ids
$(eval KB_ID := $(shell $(AWS) bedrock-agent list-knowledge-bases --query "knowledgeBaseSummaries[?name=='$(KB_NAME)'].knowledgeBaseId | [0]" --output text))
$(eval DATA_SOURCE_ID := $(shell $(AWS) bedrock-agent list-data-sources --knowledge-base-id $(KB_ID) --query "dataSourceSummaries[?name=='$(DATA_SOURCE_NAME)'].dataSourceId | [0]" --output text))
$(eval INGEST_FUNCTION := $(shell $(AWS) cloudformation describe-stack-resources --stack-name $(STACK) --logical-resource-id IngestLambda9890CC8D --query "StackResources[0].PhysicalResourceId" --output text))
endef

logs-ingest:
	$(call load_ids)
	$(AWS) logs tail /aws/lambda/$(INGEST_FUNCTION) --since $(SINCE) --follow

log-groups:
	$(AWS) logs describe-log-groups --log-group-name-prefix /aws/lambda/$(STACK)

list-kb:
	$(AWS) bedrock-agent list-knowledge-bases

list-datasources:
	$(call load_ids)
	$(AWS) bedrock-agent list-data-sources --knowledge-base-id $(KB_ID)

list-ingestion-jobs:
	$(call load_ids)
	$(AWS) bedrock-agent list-ingestion-jobs --knowledge-base-id $(KB_ID) --data-source-id $(DATA_SOURCE_ID)

describe-ingestion-job:
	$(call load_ids)
	@if [ -z "$(JOB)" ]; then echo "JOB=<id> is required" && exit 1; fi
	$(AWS) bedrock-agent get-ingestion-job --knowledge-base-id $(KB_ID) --data-source-id $(DATA_SOURCE_ID) --ingestion-job-id $(JOB)

head-doc:
	$(AWS) s3api head-object --bucket $(BUCKET) --key $(DOC_KEY)

doc-tags:
	$(AWS) s3api get-object-tagging --bucket $(BUCKET) --key $(DOC_KEY)

copy-doc:
	$(AWS) s3api copy-object --bucket $(BUCKET) --key $(DOC_KEY) --copy-source $(BUCKET)/$(DOC_KEY) --metadata-directive REPLACE

stack-status:
	$(AWS) cloudformation describe-stacks --stack-name $(STACK) --query "Stacks[0].StackStatus" --output text
