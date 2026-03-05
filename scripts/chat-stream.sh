#!/usr/bin/env bash
set -euo pipefail

CHAT_API_URL="https://o9cd6p8cr8.execute-api.us-east-1.amazonaws.com/prod/chat"

show_usage() {
  cat <<'EOF'
Usage:
  ./scripts/chat-stream.sh "Your prompt here"
  echo "Prompt" | ./scripts/chat-stream.sh

Environment overrides:
  MAX_TOKENS     (default: 1024)
  TEMPERATURE    (default: 0.3)
EOF
}

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  show_usage
  exit 0
fi

if [[ $# -gt 0 ]]; then
  PROMPT="$*"
else
  if [[ -t 0 ]]; then
    read -r -p "Enter prompt: " PROMPT
  else
    PROMPT="$(cat)"
  fi
fi

PROMPT="${PROMPT//$'\r'/}"
if [[ -z "$PROMPT" ]]; then
  echo "Prompt cannot be empty" >&2
  exit 1
fi

MAX_TOKENS="${MAX_TOKENS:-1024}"
TEMPERATURE="${TEMPERATURE:-0.3}"

PAYLOAD=$(PROMPT_TEXT="$PROMPT" PROMPT_MAX_TOKENS="$MAX_TOKENS" PROMPT_TEMPERATURE="$TEMPERATURE" python3 - <<'PY'
import json, os
prompt = os.environ['PROMPT_TEXT'].strip()
max_tokens = os.environ.get('PROMPT_MAX_TOKENS')
temperature = os.environ.get('PROMPT_TEMPERATURE')
body = {
    'prompt': prompt,
    'maxTokens': int(max_tokens) if max_tokens else 1024,
    'temperature': float(temperature) if temperature else 0.3,
}
print(json.dumps(body))
PY
)

printf "\n> %s\n\n" "$PROMPT"

curl --no-buffer -sS \
  -H 'Content-Type: application/json' \
  -H 'Accept: text/event-stream' \
  -X POST "$CHAT_API_URL" \
  -d "$PAYLOAD" | {
    in_error=0
    while IFS= read -r line || [[ -n "$line" ]]; do
      case "$line" in
        "event: error")
          in_error=1
          ;;
        data:*)
          chunk="${line#data: }"
          if [[ "$chunk" == "[DONE]" ]]; then
            printf "\n\n[done]\n"
            break
          fi
          if (( in_error )); then
            printf "\n[error] %s\n" "$chunk" >&2
            in_error=0
          else
            printf "%s" "$chunk"
          fi
          ;;
        *)
          :
          ;;
      esac
    done
  }
