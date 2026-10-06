#!/usr/bin/env bash
# Build + deploy the hosted MCP server (Lambda `ztalio-mcp`, route `ANY /v1/mcp` on the Ztalio HTTP API).
# Additive: new role, new function, one new route. Re-runnable.
set -euo pipefail
export AWS_PROFILE=tvyou AWS_REGION=us-east-1
ACCT=018915367501
API=n3rhgnp6eg
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$HERE/pkg"; FN=ztalio-mcp; ROLE=ztalio-mcp-role
rm -rf "$PKG"; mkdir -p "$PKG"
npx --yes esbuild@0.28.2 "$HERE/index.mjs" --bundle --platform=node --format=esm --target=node22 --outfile="$PKG/index.mjs" --log-level=warning
echo '{"name":"ztalio-mcp","type":"module","private":true}' > "$PKG/package.json"
(cd "$PKG" && zip -qr ../mcp.zip index.mjs package.json)
echo "bundle $(du -h "$PKG/index.mjs" | cut -f1), zip $(du -h "$HERE/mcp.zip" | cut -f1)"

TRUST='{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":{"Service":"lambda.amazonaws.com"},"Action":"sts:AssumeRole"}]}'
if ! aws iam get-role --role-name $ROLE >/dev/null 2>&1; then
  aws iam create-role --role-name $ROLE --assume-role-policy-document "$TRUST" --query 'Role.Arn' --output text
  aws iam attach-role-policy --role-name $ROLE --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole
  sleep 8
fi
if ! aws lambda get-function --function-name $FN >/dev/null 2>&1; then
  aws lambda create-function --function-name $FN --runtime nodejs24.x --architectures x86_64 --role "arn:aws:iam::$ACCT:role/$ROLE" \
    --handler index.handler --timeout 29 --memory-size 512 --zip-file "fileb://$HERE/mcp.zip" \
    --environment "Variables={ZTALIO_API_BASE=https://api.ztalio.com/v1}" --query 'FunctionArn' --output text
  aws lambda wait function-active-v2 --function-name $FN
  aws logs put-retention-policy --log-group-name /aws/lambda/$FN --retention-in-days 90 2>/dev/null || true
else
  aws lambda update-function-code --function-name $FN --zip-file "fileb://$HERE/mcp.zip" --query 'LastUpdateStatus' --output text
  aws lambda wait function-updated-v2 --function-name $FN
fi

ARN="arn:aws:lambda:us-east-1:$ACCT:function:$FN"
INT=$(aws apigatewayv2 get-integrations --api-id $API --max-results 200 --query "Items[?IntegrationUri=='$ARN'].IntegrationId | [0]" --output text)
if [[ "$INT" == "None" || -z "$INT" ]]; then
  INT=$(aws apigatewayv2 create-integration --api-id $API --integration-type AWS_PROXY --integration-uri "$ARN" --payload-format-version 2.0 --query 'IntegrationId' --output text)
  aws lambda add-permission --function-name $FN --statement-id "apigw-$API-$(date +%s)" --action lambda:InvokeFunction --principal apigateway.amazonaws.com --source-arn "arn:aws:execute-api:us-east-1:$ACCT:$API/*" >/dev/null
fi
for key in "ANY /v1/mcp"; do
  EX=$(aws apigatewayv2 get-routes --api-id $API --max-results 200 --query "Items[?RouteKey=='$key'].RouteId | [0]" --output text)
  if [[ "$EX" == "None" || -z "$EX" ]]; then aws apigatewayv2 create-route --api-id $API --route-key "$key" --target "integrations/$INT" --query 'RouteKey' --output text; else echo "route exists: $key"; fi
done
echo "deployed: https://api.ztalio.com/v1/mcp"
