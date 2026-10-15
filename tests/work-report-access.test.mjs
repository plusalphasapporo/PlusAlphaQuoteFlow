import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const html=readFileSync('index.html','utf8');
test('work report opens even when some procedure steps remain incomplete',()=>{
  const from=html.indexOf("const closeBtn=$('#ticketCloseBtn');");
  const to=html.indexOf('mountAppModal(',from);
  assert.ok(from>=0&&to>from,'work report handler must exist');
  const preflight=html.slice(from,to);
  assert.doesNotMatch(preflight,/if\s*\(\s*support\s*&&\s*procedureState\.length\s*&&\s*pendingProcedure\.length\s*\)/,
    'The handler must not silently redirect away from the report when steps are pending');
  assert.match(html,/id="workReportRemaining"/,'pending steps must remain visible in the report');
});

test('empty automatic report opens manual entry fields instead of looking unresponsive',()=>{
  const from=html.indexOf('const buildWorkReportFromSteps=');
  assert.ok(from>=0,'report builder must exist');
  const fragment=html.slice(from,from+8500);
  assert.match(fragment,/workReportEditDetails.*open|open.*workReportEditDetails/s,
    'manual entry section must open when there is no automatic work report text');
});
