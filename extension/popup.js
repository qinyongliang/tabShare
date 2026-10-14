const $ = id => document.getElementById(id);
$('settings').onclick = () => chrome.runtime.openOptionsPage();
const [active] = await chrome.tabs.query({active: true, currentWindow: true});
if (active?.url?.startsWith('http')) $('url').value = active.url;
async function request(message) {
  const response = await chrome.runtime.sendMessage(message);
  if (!response.ok) throw new Error(response.error);
  return response.value;
}
async function share(kind) {
  $('result').textContent = '正在创建分享…';
  try {
    await request({type: 'share', kind, url: kind === 'tab' ? active?.url : $('url').value, tabId: active?.id, title: kind === 'tab' ? active?.title : ''});
    $('result').textContent = '分享已创建。复制下方链接即可访问。';
    await render();
  } catch (error) { $('result').textContent = error.message; }
}
$('share-tab').onclick = () => share('tab');
$('share-url').onsubmit = event => { event.preventDefault(); void share('url'); };
async function render() {
  const {shares = {}} = await chrome.storage.local.get('shares');
  $('shares').replaceChildren();
  for (const share of Object.values(shares).reverse()) {
    const card = document.createElement('article');
    const title = document.createElement('strong'); title.textContent = share.title;
    const link = document.createElement('input'); link.readOnly = true; link.value = share.shareUrl; link.onclick = () => link.select();
    const copy = document.createElement('button'); copy.className = 'secondary'; copy.textContent = '复制链接';
    copy.onclick = async () => { try { await navigator.clipboard.writeText(share.shareUrl); $('result').textContent = '已复制'; } catch { link.select(); $('result').textContent = '请复制已选中的链接'; } };
    const stop = document.createElement('button'); stop.className = 'danger'; stop.textContent = '停止并撤销链接';
    stop.onclick = async () => { try { await request({type: 'revoke', id: share.id}); await render(); $('result').textContent = '分享已撤销'; } catch (error) { $('result').textContent = error.message; } };
    card.append(title, link, copy, stop); $('shares').append(card);
  }
}
await render();
