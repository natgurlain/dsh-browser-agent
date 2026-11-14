import { createServer } from 'node:http'
import { makeTaskInstance, TASK_IDS } from '../lib/tasks.mjs'

function readJson(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    request.on('error', reject)
  })
}

function json(response, status, value) {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  response.end(JSON.stringify(value))
}

function htmlEscape(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;')
}

function layout(instance, body, script = '') {
  const data = JSON.stringify({
    runId: instance.runId,
    taskId: instance.id,
    page: instance.page,
  }).replaceAll('<', '\\u003c')
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEscape(instance.page.title)} · DSH Browser Benchmark</title>
  <style>
    :root { color-scheme: light; font: 16px/1.5 system-ui, sans-serif; color: #17202a; background: #f3f5f7; }
    body { margin: 0; }
    header { padding: 18px 28px; color: white; background: #16324f; }
    header strong { font-size: 20px; }
    main { width: min(920px, calc(100% - 40px)); margin: 28px auto; padding: 28px; background: white; border-radius: 12px; box-shadow: 0 8px 28px #19324f18; }
    h1 { margin-top: 0; }
    table { width: 100%; border-collapse: collapse; }
    th, td { padding: 11px 12px; text-align: left; border-bottom: 1px solid #dde3e8; }
    label { display: block; margin: 14px 0 5px; font-weight: 650; }
    input, select { box-sizing: border-box; width: min(420px, 100%); padding: 10px 12px; border: 1px solid #aeb9c4; border-radius: 7px; font: inherit; }
    input[type=checkbox] { width: auto; margin-right: 8px; }
    button { margin-top: 16px; padding: 10px 16px; border: 0; border-radius: 7px; color: white; background: #1769aa; font: 650 15px system-ui; cursor: pointer; }
    .product, .record { margin: 10px 0; padding: 14px; border: 1px solid #dce3e9; border-radius: 8px; }
    .product button { margin-left: 16px; }
    .notice { margin-top: 18px; padding: 12px; border-radius: 7px; color: #155724; background: #d4edda; }
    .lazy-spacer .record { min-height: 100px; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <header><strong>DSH Browser Benchmark</strong></header>
  <main>${body}</main>
  <script>window.__BENCHMARK__ = ${data};</script>
  <script>
    async function benchmarkAction(action, payload = {}) {
      const response = await fetch('/api/action', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ runId: window.__BENCHMARK__.runId, taskId: window.__BENCHMARK__.taskId, action, payload })
      });
      if (!response.ok) throw new Error('benchmark action failed');
      return response.json();
    }
    ${script}
  </script>
</body>
</html>`
}

function renderTask(instance) {
  const { id, page } = instance
  if (id === 'order_lookup') {
    const rows = page.orders.map((order) => `<tr><td>${htmlEscape(order.id)}</td><td>${htmlEscape(order.customer)}</td><td>¥${(order.cents / 100).toFixed(2)}</td></tr>`).join('')
    return layout(instance, `<h1>订单中心</h1><p>最近订单如下。</p><table><thead><tr><th>订单号</th><th>客户</th><th>总金额</th></tr></thead><tbody>${rows}</tbody></table>`)
  }
  if (id === 'notification_toggle') {
    return layout(instance, `<h1>账户设置</h1><p>账户：<strong>${htmlEscape(page.account)}</strong></p><form id="settings-form"><label><input id="email-notifications" type="checkbox">邮件通知</label><button type="submit">保存设置</button></form><p id="saved" class="notice" hidden>设置已保存</p>`, `
      document.querySelector('#settings-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        await benchmarkAction('save-notifications', { enabled: document.querySelector('#email-notifications').checked });
        document.querySelector('#saved').hidden = false;
      });`)
  }
  if (id === 'contact_form') {
    return layout(instance, `<h1>联系信息</h1><form id="contact-form"><label for="name">姓名</label><input id="name" name="name" autocomplete="off"><label for="email">邮箱</label><input id="email" name="email" type="email" autocomplete="off"><label for="city">城市</label><input id="city" name="city" autocomplete="off"><button type="submit">提交联系信息</button></form><p id="submitted" class="notice" hidden>联系信息已提交</p>`, `
      document.querySelector('#contact-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = new FormData(event.currentTarget);
        await benchmarkAction('submit-contact', Object.fromEntries(form));
        document.querySelector('#submitted').hidden = false;
      });`)
  }
  if (id === 'inventory_filter') {
    return layout(instance, `<h1>库存查询</h1><form id="filter-form"><label for="sku">SKU 包含</label><input id="sku" name="sku" autocomplete="off"><label for="maximum">最高价格（元）</label><input id="maximum" name="maximum" inputmode="decimal" autocomplete="off"><button type="submit">应用筛选</button></form><section id="results" aria-live="polite"><p>请先应用筛选。</p></section>`, `
      const products = window.__BENCHMARK__.page.products;
      document.querySelector('#filter-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        const sku = document.querySelector('#sku').value.trim();
        const maximumCents = Math.round(Number(document.querySelector('#maximum').value) * 100);
        await benchmarkAction('apply-filter', { sku, maximumCents });
        const matches = products.filter((product) => product.sku.includes(sku) && product.cents <= maximumCents);
        document.querySelector('#results').innerHTML = matches.length === 0
          ? '<p>没有匹配商品</p>'
          : matches.map((product) => '<article class="product"><strong>' + product.name + '</strong><br>SKU：' + product.sku + '<br>价格：¥' + (product.cents / 100).toFixed(2) + '</article>').join('');
      });`)
  }
  if (id === 'cart_checkout') {
    const products = page.products.map((product) => `<article class="product"><strong>${htmlEscape(product.name)}</strong><span> · ¥${(product.cents / 100).toFixed(2)}</span><button type="button" data-product-id="${htmlEscape(product.id)}">加入购物车</button></article>`).join('')
    return layout(instance, `<h1>商品目录</h1><section id="catalog">${products}</section><section id="cart" hidden><h2>购物车</h2><p id="cart-name"></p><label for="quantity">数量</label><input id="quantity" type="number" min="1" value="1"><button id="checkout" type="button">完成结算</button></section><p id="complete" class="notice" hidden>结算完成</p>`, `
      const products = window.__BENCHMARK__.page.products;
      let selected = null;
      for (const button of document.querySelectorAll('[data-product-id]')) {
        button.addEventListener('click', async () => {
          selected = button.dataset.productId;
          await benchmarkAction('add-cart', { productId: selected });
          const product = products.find((item) => item.id === selected);
          document.querySelector('#cart-name').textContent = product.name;
          document.querySelector('#cart').hidden = false;
        });
      }
      document.querySelector('#checkout').addEventListener('click', async () => {
        const quantity = Number(document.querySelector('#quantity').value);
        await benchmarkAction('checkout', { productId: selected, quantity });
        document.querySelector('#complete').hidden = false;
      });`)
  }
  if (id === 'plan_select') {
    const options = page.plans.map((plan) => `<option value="${htmlEscape(plan.value)}">${htmlEscape(plan.label)}</option>`).join('')
    const regions = page.regions.map((region) => `<li role="option" data-value="${htmlEscape(region)}">${htmlEscape(region)}</li>`).join('')
    return layout(instance, `<h1>订阅设置</h1><form id="plan-form"><label for="plan">套餐</label><select id="plan"><option value="">请选择</option>${options}</select>
      <label id="region-label">计费地区</label><div id="region" role="combobox" tabindex="0" aria-labelledby="region-label" aria-expanded="false" aria-controls="region-list" class="combo">请选择地区</div>
      <ul id="region-list" role="listbox" hidden>${regions}</ul><button type="submit">保存订阅</button></form><p id="saved" class="notice" hidden>订阅已保存</p>`, `
      const region = document.querySelector('#region');
      const list = document.querySelector('#region-list');
      let chosen = '';
      region.addEventListener('click', () => { list.hidden = !list.hidden; region.setAttribute('aria-expanded', String(!list.hidden)); });
      for (const option of list.querySelectorAll('[role="option"]')) {
        option.addEventListener('click', () => {
          chosen = option.dataset.value;
          region.textContent = option.textContent;
          for (const other of list.children) other.setAttribute('aria-selected', String(other === option));
          list.hidden = true;
          region.setAttribute('aria-expanded', 'false');
        });
      }
      document.querySelector('#plan-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        await benchmarkAction('save-subscription', { plan: document.querySelector('#plan').value, region: chosen });
        document.querySelector('#saved').hidden = false;
      });`)
  }
  if (id === 'shadow_toggle') {
    return layout(instance, `<h1>安全设置</h1><p>账户：<strong>${htmlEscape(page.account)}</strong></p><security-panel></security-panel><p id="saved" class="notice" hidden>安全设置已保存</p>`, `
      customElements.define('security-panel', class extends HTMLElement {
        connectedCallback() {
          const root = this.attachShadow({ mode: 'open' });
          root.innerHTML = '<style>.switch{display:inline-flex;gap:8px;align-items:center;padding:8px;cursor:pointer}.switch input{opacity:0;position:absolute;width:1px;height:1px}.track{width:36px;height:20px;border-radius:10px;background:#aeb9c4}.switch input:checked+.track{background:#1769aa}button{margin-top:12px}</style>'
            + '<label class="switch"><input id="two-factor" type="checkbox"><span class="track"></span><span>两步验证</span></label><br><button id="save" type="button">保存安全设置</button>';
          root.querySelector('#save').addEventListener('click', async () => {
            await benchmarkAction('save-security', { twoFactor: root.querySelector('#two-factor').checked });
            document.querySelector('#saved').hidden = false;
          });
        }
      });`)
  }
  if (id === 'delayed_report') {
    return layout(instance, `<h1>报表中心</h1><button id="generate" type="button">生成报表</button><p id="progress" role="status"></p><p id="result" hidden>报表编号：<strong id="code"></strong></p>`, `
      document.querySelector('#generate').addEventListener('click', async () => {
        document.querySelector('#progress').textContent = '报表生成中…';
        await benchmarkAction('request-report');
        setTimeout(() => {
          document.querySelector('#progress').textContent = '报表已生成';
          document.querySelector('#code').textContent = window.__BENCHMARK__.page.code;
          document.querySelector('#result').hidden = false;
        }, window.__BENCHMARK__.page.delayMs);
      });`)
  }
  if (id === 'feed_scroll') {
    return layout(instance, `<h1>消息流</h1><p>消息流区域滚动到底部会自动加载更多。</p><section id="feed" aria-label="消息流" style="height:320px;overflow-y:auto;border:1px solid #dce3e9;border-radius:8px;padding:0 12px"></section>`, `
      const { target, code, batch } = window.__BENCHMARK__.page;
      const feed = document.querySelector('#feed');
      let count = 0, loading = false;
      function append() {
        for (let i = 0; i < batch; i++) {
          count += 1;
          const entry = document.createElement('article');
          entry.className = 'record';
          entry.textContent = '第 ' + count + ' 条消息 · 代码 ' + (count === target ? code : 'MSG-' + (1000 + count * 7));
          feed.append(entry);
        }
      }
      append();
      feed.addEventListener('scroll', async () => {
        if (loading || feed.scrollTop + feed.clientHeight < feed.scrollHeight - 10 || count >= target + batch) return;
        loading = true;
        await new Promise((resolve) => setTimeout(resolve, 400));
        append();
        await benchmarkAction('load-feed', { count, targetLoaded: count >= target });
        loading = false;
      });`)
  }
  if (id === 'ledger_total') {
    return layout(instance, `<h1>账目明细</h1><table id="ledger"><thead><tr><th>编号</th><th>金额</th></tr></thead><tbody></tbody></table>
      <p><button id="prev" type="button">上一页</button> <span id="page-label"></span> <button id="next" type="button">下一页</button></p>`, `
      const { entries, perPage } = window.__BENCHMARK__.page;
      const pages = Math.ceil(entries.length / perPage);
      let current = 0;
      const format = (cents) => '¥' + (cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      function render() {
        document.querySelector('#ledger tbody').innerHTML = entries.slice(current * perPage, (current + 1) * perPage)
          .map((entry) => '<tr><td>' + entry.ref + '</td><td>' + format(entry.cents) + '</td></tr>').join('');
        document.querySelector('#page-label').textContent = '第 ' + (current + 1) + ' / ' + pages + ' 页';
        document.querySelector('#prev').disabled = current === 0;
        document.querySelector('#next').disabled = current === pages - 1;
      }
      document.querySelector('#next').addEventListener('click', () => { if (current < pages - 1) { current += 1; render(); } });
      document.querySelector('#prev').addEventListener('click', () => { if (current > 0) { current -= 1; render(); } });
      render();`)
  }
  if (id === 'signup_fix') {
    return layout(instance, `<h1>注册账号</h1><form id="signup" novalidate><label for="username">用户名</label><input id="username" autocomplete="off" aria-describedby="username-error"><p id="username-error"></p>
      <label for="email">邮箱</label><input id="email" type="email" autocomplete="off"><div id="form-alert" role="alert"></div><button type="submit">注册</button></form><p id="done" class="notice" hidden>注册成功</p>`, `
      const { username, suggestion } = window.__BENCHMARK__.page;
      document.querySelector('#signup').addEventListener('submit', async (event) => {
        event.preventDefault();
        const field = document.querySelector('#username');
        const email = document.querySelector('#email').value.trim();
        if (field.value.trim() === username) {
          field.setAttribute('aria-invalid', 'true');
          document.querySelector('#username-error').textContent = '该用户名已被占用';
          document.querySelector('#form-alert').textContent = '用户名 ' + username + ' 已被占用，请改用 ' + suggestion + ' 后重新提交。';
          await benchmarkAction('signup-rejected', { username: field.value.trim() });
          return;
        }
        field.removeAttribute('aria-invalid');
        document.querySelector('#form-alert').textContent = '';
        await benchmarkAction('signup', { username: field.value.trim(), email });
        document.querySelector('#done').hidden = false;
      });`)
  }
  if (id === 'confirm_delete') {
    const rows = page.drafts.map((draft) => `<article class="record"><strong>${htmlEscape(draft.title)}</strong><button type="button" data-draft-id="${htmlEscape(draft.id)}" data-title="${htmlEscape(draft.title)}">删除</button></article>`).join('')
    return layout(instance, `<h1>草稿箱</h1><section id="drafts">${rows}</section><p id="deleted" class="notice" hidden>草稿已删除</p>`, `
      for (const button of document.querySelectorAll('[data-draft-id]')) {
        button.addEventListener('click', async () => {
          if (!confirm('确定删除“' + button.dataset.title + '”吗？此操作无法撤销。')) return;
          await benchmarkAction('delete-draft', { draftId: button.dataset.draftId });
          button.closest('article').remove();
          document.querySelector('#deleted').hidden = false;
        });
      }`)
  }
  if (id === 'hover_menu') {
    return layout(instance, `<h1>销售报表</h1><p>本季度销售额汇总。</p><div id="more" class="product" style="display:inline-block;position:relative">更多操作 ▾<div id="menu" style="position:absolute;left:0;top:100%;background:white;border:1px solid #ccc;padding:8px;min-width:160px"></div></div><p id="exported" class="notice" hidden></p>`, `
      const more = document.querySelector('#more');
      const menu = document.querySelector('#menu');
      let closeTimer;
      // The menu exists only while the pointer is over it, like many real dropdowns.
      more.addEventListener('mouseenter', () => {
        clearTimeout(closeTimer);
        if (menu.childElementCount > 0) return;
        for (const format of window.__BENCHMARK__.page.formats) {
          const item = document.createElement('button');
          item.type = 'button'; item.textContent = '导出 ' + format; item.style.display = 'block';
          item.addEventListener('click', async () => {
            await benchmarkAction('export', { format });
            const done = document.querySelector('#exported'); done.textContent = '已导出 ' + format; done.hidden = false;
          });
          menu.append(item);
        }
      });
      more.addEventListener('mouseleave', () => { closeTimer = setTimeout(() => menu.replaceChildren(), 400) });`)
  }
  if (id === 'drag_assign') {
    const cards = page.cards.map((card) => `<div class="product" draggable="true" data-card-id="${htmlEscape(card.id)}">${htmlEscape(card.title)}</div>`).join('')
    const lanes = page.lanes.map((lane, index) => `<section class="lane record" data-lane="${htmlEscape(lane)}" style="min-height:140px"><h2>${htmlEscape(lane)}</h2>${index === 0 ? cards : ''}</section>`).join('')
    return layout(instance, `<h1>任务看板</h1><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:12px">${lanes}</div>`, `
      for (const card of document.querySelectorAll('[data-card-id]')) {
        card.addEventListener('dragstart', (event) => { event.dataTransfer.setData('text/plain', card.dataset.cardId) });
      }
      for (const lane of document.querySelectorAll('[data-lane]')) {
        lane.addEventListener('dragover', (event) => { event.preventDefault() });
        lane.addEventListener('drop', async (event) => {
          event.preventDefault();
          const cardId = event.dataTransfer.getData('text/plain');
          const card = document.querySelector('[data-card-id="' + cardId + '"]');
          if (card === null) return;
          lane.append(card);
          await benchmarkAction('move-card', { cardId, lane: lane.dataset.lane });
        });
      }`)
  }
  if (id === 'covered_subscribe') {
    return layout(instance, `<h1>新闻通讯</h1><form id="subscribe-form"><label for="email">邮箱</label><input id="email" type="email" autocomplete="off"><button id="subscribe" type="submit">订阅</button></form><p id="subscribed" class="notice" hidden>订阅成功</p>
      <div id="banner" role="dialog" aria-label="通知" style="position:fixed;left:0;right:0;top:0;bottom:0;background:rgba(20,30,40,.55);display:grid;place-items:center"><div style="background:white;padding:20px;border-radius:10px"><p>我们使用 Cookie 改善体验。</p><button id="dismiss" type="button">同意并关闭</button></div></div>`, `
      document.querySelector('#dismiss').addEventListener('click', () => document.querySelector('#banner').remove());
      document.querySelector('#subscribe-form').addEventListener('submit', async (event) => {
        event.preventDefault();
        await benchmarkAction('subscribe', { email: document.querySelector('#email').value.trim() });
        document.querySelector('#subscribed').hidden = false;
      });`)
  }
  if (id === 'pdf_lookup') {
    return layout(instance, `<h1>账单</h1><p>本月账单已生成，请查看附件。</p><p><a id="invoice" href="${htmlEscape(page.pdfUrl)}">发票 PDF</a></p>`)
  }
  const filler = Array.from({ length: page.fillerCount }, (_, index) => `<article class="record"><strong>历史记录 ${index + 1}</strong><p>这是用于测试滚动和懒加载的归档内容。</p></article>`).join('')
  return layout(instance, `<h1>归档记录</h1><p>目标记录位于当前已加载内容之后。</p><section class="lazy-spacer">${filler}</section><button id="load-more" type="button">加载更多记录</button><article id="new-record" class="record notice" hidden><strong>新记录</strong><p>目标代码：<span id="target-code"></span></p></article>`, `
    document.querySelector('#load-more').addEventListener('click', async () => {
      await benchmarkAction('load-more');
      document.querySelector('#target-code').textContent = window.__BENCHMARK__.page.code;
      document.querySelector('#new-record').hidden = false;
      document.querySelector('#load-more').disabled = true;
    });`)
}

/**
 * A minimal one-page PDF (Helvetica, one text line per entry) with a correct
 * cross-reference table, so the browser's PDF viewer opens it.
 */
export function simplePdf(lines) {
  const escape = (text) => text.replace(/[\\()]/g, (char) => `\\${char}`)
  const content = ['BT', '/F1 14 Tf', '72 760 Td', '18 TL']
    .concat(lines.map((line, index) => `${index === 0 ? '' : 'T* '}(${escape(line)}) Tj`))
    .concat(['ET'])
    .join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content, 'latin1')} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
  ]
  let body = '%PDF-1.4\n'
  const offsets = []
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(body, 'latin1'))
    body += `${index + 1} 0 obj\n${object}\nendobj\n`
  })
  const xref = Buffer.byteLength(body, 'latin1')
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (const offset of offsets) body += `${String(offset).padStart(10, '0')} 00000 n \n`
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(body, 'latin1')
}

function initialState(taskId) {
  return { taskId, createdAt: Date.now() }
}

function applyAction(state, taskId, action, payload) {
  if (taskId === 'notification_toggle' && action === 'save-notifications') {
    return { ...state, notificationSaved: true, emailNotifications: payload.enabled === true, updatedAt: Date.now() }
  }
  if (taskId === 'contact_form' && action === 'submit-contact') {
    return { ...state, formSubmitted: true, form: { name: String(payload.name ?? ''), email: String(payload.email ?? ''), city: String(payload.city ?? '') }, updatedAt: Date.now() }
  }
  if (taskId === 'inventory_filter' && action === 'apply-filter') {
    return { ...state, filterApplied: true, filter: { sku: String(payload.sku ?? ''), maximumCents: Number(payload.maximumCents) }, updatedAt: Date.now() }
  }
  if (taskId === 'cart_checkout' && action === 'add-cart') {
    return { ...state, cart: { productId: String(payload.productId ?? ''), quantity: 1 }, updatedAt: Date.now() }
  }
  if (taskId === 'cart_checkout' && action === 'checkout') {
    return { ...state, checkedOut: true, cart: { productId: String(payload.productId ?? ''), quantity: Number(payload.quantity) }, updatedAt: Date.now() }
  }
  if (taskId === 'confirm_delete' && action === 'delete-draft') {
    return { ...state, deletedDraft: String(payload.draftId ?? ''), deletedCount: (state.deletedCount ?? 0) + 1, updatedAt: Date.now() }
  }
  if (taskId === 'hover_menu' && action === 'export') {
    return { ...state, exported: String(payload.format ?? ''), updatedAt: Date.now() }
  }
  if (taskId === 'drag_assign' && action === 'move-card') {
    return { ...state, moved: { cardId: String(payload.cardId ?? ''), lane: String(payload.lane ?? '') }, updatedAt: Date.now() }
  }
  if (taskId === 'covered_subscribe' && action === 'subscribe') {
    return { ...state, subscribed: true, email: String(payload.email ?? ''), updatedAt: Date.now() }
  }
  if (taskId === 'lazy_load' && action === 'load-more') {
    return { ...state, loadedMore: true, updatedAt: Date.now() }
  }
  if (taskId === 'plan_select' && action === 'save-subscription') {
    return { ...state, subscriptionSaved: true, plan: String(payload.plan ?? ''), region: String(payload.region ?? ''), updatedAt: Date.now() }
  }
  if (taskId === 'shadow_toggle' && action === 'save-security') {
    return { ...state, securitySaved: true, twoFactor: payload.twoFactor === true, updatedAt: Date.now() }
  }
  if (taskId === 'delayed_report' && action === 'request-report') {
    return { ...state, reportRequested: true, updatedAt: Date.now() }
  }
  if (taskId === 'feed_scroll' && action === 'load-feed') {
    return { ...state, feedLoaded: Number(payload.count), feedTargetLoaded: state.feedTargetLoaded === true || payload.targetLoaded === true, updatedAt: Date.now() }
  }
  if (taskId === 'signup_fix' && action === 'signup-rejected') {
    return { ...state, rejectedAttempts: (state.rejectedAttempts ?? 0) + 1, updatedAt: Date.now() }
  }
  if (taskId === 'signup_fix' && action === 'signup') {
    return { ...state, signedUp: true, account: { username: String(payload.username ?? ''), email: String(payload.email ?? '') }, updatedAt: Date.now() }
  }
  throw new Error(`invalid action ${action} for ${taskId}`)
}

export async function startBenchmarkSite({ host = '127.0.0.1', port = 4173 } = {}) {
  const states = new Map()
  const server = createServer(async (request, response) => {
    const origin = `http://${request.headers.host ?? `${host}:${port}`}`
    const url = new URL(request.url ?? '/', origin)
    try {
      if (request.method === 'GET' && url.pathname === '/health') {
        json(response, 200, { ok: true })
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/reset') {
        const body = await readJson(request)
        if (typeof body.runId !== 'string' || !TASK_IDS.includes(body.taskId)) throw new Error('invalid reset payload')
        const state = initialState(body.taskId)
        states.set(body.runId, state)
        json(response, 200, state)
        return
      }
      if (request.method === 'GET' && url.pathname === '/api/state') {
        const runId = url.searchParams.get('run') ?? ''
        json(response, 200, states.get(runId) ?? {})
        return
      }
      if (request.method === 'POST' && url.pathname === '/api/action') {
        const body = await readJson(request)
        if (typeof body.runId !== 'string' || !TASK_IDS.includes(body.taskId) || typeof body.action !== 'string') throw new Error('invalid action payload')
        const current = states.get(body.runId) ?? initialState(body.taskId)
        const next = applyAction(current, body.taskId, body.action, body.payload ?? {})
        states.set(body.runId, next)
        json(response, 200, next)
        return
      }
      if (request.method === 'GET' && url.pathname === '/doc/invoice.pdf') {
        const seed = Number(url.searchParams.get('seed'))
        const runId = url.searchParams.get('run') ?? ''
        if (!Number.isInteger(seed) || seed < 1 || runId === '') {
          json(response, 400, { error: 'invalid document URL' })
          return
        }
        const instance = makeTaskInstance('pdf_lookup', seed, runId, origin)
        response.writeHead(200, { 'content-type': 'application/pdf', 'cache-control': 'no-store' })
        response.end(simplePdf(['ACME Supplies Ltd.', 'Invoice', `Invoice No: ${instance.page.invoice}`, `Amount due: EUR ${(120 + seed * 7).toFixed(2)}`]))
        return
      }
      if (request.method === 'GET' && url.pathname.startsWith('/task/')) {
        const taskId = url.pathname.slice('/task/'.length)
        const seed = Number(url.searchParams.get('seed'))
        const runId = url.searchParams.get('run') ?? ''
        if (!TASK_IDS.includes(taskId) || !Number.isInteger(seed) || seed < 1 || runId === '') {
          json(response, 400, { error: 'invalid task URL' })
          return
        }
        states.set(runId, states.get(runId) ?? initialState(taskId))
        const instance = makeTaskInstance(taskId, seed, runId, origin)
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        response.end(renderTask(instance))
        return
      }
      json(response, 404, { error: 'not found' })
    } catch (error) {
      json(response, 400, { error: error instanceof Error ? error.message : String(error) })
    }
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => resolve())
  })
  const address = server.address()
  const actualPort = typeof address === 'object' && address !== null ? address.port : port
  return {
    origin: `http://${host}:${actualPort}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.BENCHMARK_SITE_PORT ?? 4173)
  const site = await startBenchmarkSite({ port })
  console.log(`benchmark site listening on ${site.origin}`)
}
