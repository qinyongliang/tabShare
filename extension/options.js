import {serverOrigin} from './controller.js';
const $ = id => document.getElementById(id);
const config = await chrome.storage.local.get(['server', 'pairingToken', 'enabled']);
$('server').value = config.server || 'http://localhost:8080';
$('token').value = config.pairingToken || '';
$('enabled').checked = !!config.enabled;
$('settings').addEventListener('submit', async event => {
  event.preventDefault();
  try {
    const server = serverOrigin($('server').value.trim());
    const pairingToken = $('token').value.trim();
    if (pairingToken.length < 32) throw new Error('请填写完整的服务器配对令牌');
    const granted = await chrome.permissions.request({origins: [server + '/*']});
    if (!granted) throw new Error('需要允许访问所配置的服务器');
    await chrome.storage.local.set({server, pairingToken, enabled: $('enabled').checked});
    const response = await chrome.runtime.sendMessage({type: 'reconnect'});
    if (!response.ok) throw new Error(response.error);
    $('result').textContent = $('enabled').checked ? '已保存并连接服务器' : '已保存，远程连接已暂停';
  } catch (error) { $('result').textContent = error.message; }
});
