// AWS adapters. In demo mode (default) nothing leaves this machine and deterministic
// engines stand in for Bedrock/Textract. Set AI_MODE=aws and install the optional
// @aws-sdk packages to use real services. Every adapter fails closed: on error the
// caller falls back to the rules engine and the output is labelled accordingly.

export const MODE = process.env.AI_MODE === 'aws' ? 'aws' : 'demo';
const REGION = process.env.AWS_REGION || 'us-east-1';

async function sdk(name) {
  try {
    return await import(name);
  } catch {
    throw new Error(`${name} is not installed. Run "npm install" with optional dependencies to enable AWS mode.`);
  }
}

/** Amazon Bedrock (Converse API) — returns parsed JSON from the model. */
export async function bedrockJSON({ system, prompt, maxTokens = 1200 }) {
  const modelId = process.env.BEDROCK_MODEL_ID;
  if (!modelId) throw new Error('BEDROCK_MODEL_ID is not set.');
  const { BedrockRuntimeClient, ConverseCommand } = await sdk('@aws-sdk/client-bedrock-runtime');
  const client = new BedrockRuntimeClient({ region: REGION });
  const res = await client.send(new ConverseCommand({
    modelId,
    system: [{ text: system }],
    messages: [{ role: 'user', content: [{ text: prompt }] }],
    inferenceConfig: { maxTokens, temperature: 0.2 },
  }));
  const text = res.output?.message?.content?.map((c) => c.text || '').join('') || '';
  const json = text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1);
  return { data: JSON.parse(json), modelId };
}

/** Amazon Textract AnalyzeExpense on a document stored in S3. Returns normalised fields. */
export async function textractAnalyzeExpense({ bucket, key }) {
  const { TextractClient, AnalyzeExpenseCommand } = await sdk('@aws-sdk/client-textract');
  const client = new TextractClient({ region: REGION });
  const res = await client.send(new AnalyzeExpenseCommand({ Document: { S3Object: { Bucket: bucket, Name: key } } }));
  const doc = res.ExpenseDocuments?.[0] || {};
  const map = {
    INVOICE_RECEIPT_ID: 'invoiceNumber', INVOICE_RECEIPT_DATE: 'issueDate', DUE_DATE: 'dueDate', PAYMENT_TERMS: 'paymentTerms',
    RECEIVER_NAME: 'customerName', PO_NUMBER: 'poNumber', SUBTOTAL: 'subtotal', TAX: 'tax', TOTAL: 'total', AMOUNT_DUE: 'total',
  };
  const fields = {};
  for (const f of doc.SummaryFields || []) {
    const k = map[f.Type?.Text];
    if (!k || fields[k]) continue;
    fields[k] = { value: f.ValueDetection?.Text ?? null, confidence: (f.ValueDetection?.Confidence ?? 0) / 100 };
  }
  const lineItems = [];
  for (const g of doc.LineItemGroups || []) {
    for (const li of g.LineItems || []) {
      const get = (t) => li.LineItemExpenseFields?.find((x) => x.Type?.Text === t);
      lineItems.push({
        description: get('ITEM')?.ValueDetection?.Text, quantity: get('QUANTITY')?.ValueDetection?.Text,
        unitPrice: get('UNIT_PRICE')?.ValueDetection?.Text, amount: get('PRICE')?.ValueDetection?.Text,
        confidence: Math.min(...(li.LineItemExpenseFields || []).map((x) => (x.ValueDetection?.Confidence ?? 0) / 100)),
      });
    }
  }
  return { fields, lineItems };
}

/** S3 storage for invoice documents (SSE-KMS, private bucket). */
export async function putInvoiceDocument({ key, body, contentType }) {
  const { S3Client, PutObjectCommand } = await sdk('@aws-sdk/client-s3');
  const client = new S3Client({ region: REGION });
  await client.send(new PutObjectCommand({
    Bucket: process.env.INVOICE_BUCKET, Key: key, Body: body, ContentType: contentType,
    ServerSideEncryption: 'aws:kms', SSEKMSKeyId: process.env.INVOICE_KMS_KEY_ID,
  }));
  return { bucket: process.env.INVOICE_BUCKET, key };
}
