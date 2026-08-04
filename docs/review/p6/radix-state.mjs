import { chromium } from 'playwright';
const B='https://localhost';
const b=await chromium.launch();
const c=await b.newContext({ignoreHTTPSErrors:true,viewport:{width:1440,height:1200}});
const p=await c.newPage();
await p.goto(`${B}/login`,{waitUntil:'domcontentloaded'});
await p.getByLabel(/tenant/i).fill('tnt_demo_retail');
await p.getByLabel(/email/i).fill('security.manager@northgate.demo');
await p.getByLabel(/password/i).fill('Vip-Demo-2026!');
await p.getByRole('button',{name:/sign in/i}).click();
await p.waitForURL(u=>!u.pathname.startsWith('/login'));
await p.goto(`${B}/rules/rule_demo_retail_afterhours`,{waitUntil:'domcontentloaded'});
await p.waitForTimeout(3500);
console.log(await p.evaluate(()=>{
  const out=[];
  document.querySelectorAll('select').forEach((s,i)=>
    out.push(`hidden select[${i}] value=${JSON.stringify(s.value)} options=[${[...s.options].map(o=>o.value).join(',')}]`));
  document.querySelectorAll('button[role="combobox"]').forEach((btn,i)=>
    out.push(`combobox[${i}] text="${btn.textContent.trim()}" data-placeholder=${btn.hasAttribute('data-placeholder')} aria-expanded=${btn.getAttribute('aria-expanded')}`));
  const name=document.querySelector('input#name, input[name="name"]');
  out.push(`name input value="${name?.value ?? 'NOT FOUND'}"`);
  return out.join('\n');
}));
await b.close();
