import test from 'node:test';
import assert from 'node:assert/strict';
import { assertSalesReportOrigin, salesReportIdentity, readSalesReportInput } from '../app/lib/sales-report-service.ts';

test('report identity requires platform user and account identity, while the role cookie only limits the experience',()=>{
  assert.throws(()=>salesReportIdentity(new Request('https://work.example/api/sales-reports',{headers:{cookie:'ctai_experience_role=manager'}})),{status:401});
  const headers={'oai-authenticated-user-id':'alice','oai-authenticated-user-email':'alice@example.com'};
  assert.equal(salesReportIdentity(new Request('https://work.example/api/sales-reports',{headers})),'alice');
  assert.throws(()=>salesReportIdentity(new Request('https://work.example/api/sales-reports',{headers:{...headers,cookie:'ctai_experience_role=sales'}})),{status:403});
  assert.throws(()=>assertSalesReportOrigin(new Request('https://work.example/api/sales-reports',{headers:{origin:'https://other.example'}})),{status:403});
  assert.throws(()=>assertSalesReportOrigin(new Request('https://work.example/api/sales-reports',{headers:{'sec-fetch-site':'cross-site'}})),{status:403});
});
test('report bodies are read with a streaming byte cap and service callers may submit an empty body',async()=>{
  assert.deepEqual(await readSalesReportInput(new Request('https://work.example/api/sales-reports/maintenance',{method:'POST'}),true),{});
  assert.deepEqual(await readSalesReportInput(new Request('https://work.example/api/sales-reports',{method:'POST',headers:{'content-type':'application/json'},body:'{"action":"generate"}'})),{action:'generate'});
  await assert.rejects(readSalesReportInput(new Request('https://work.example/api/sales-reports',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({text:'录入'.repeat(1000)})})),{status:413});
  await assert.rejects(readSalesReportInput(new Request('https://work.example/api/sales-reports',{method:'POST',headers:{'content-type':'application/json'},body:'[]'})),{status:400});
  await assert.rejects(readSalesReportInput(new Request('https://work.example/api/sales-reports',{method:'POST',body:'{"action":"generate"}'})),{status:415});
});
