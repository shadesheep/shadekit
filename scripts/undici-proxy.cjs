// Loaded with Node's --require before `wxt submit`; no network request is made here.
const { ProxyAgent, setGlobalDispatcher } = require('undici');

const proxyUrl = process.env.DEVTOOLS_PROXY_URL;
if (proxyUrl) {
  setGlobalDispatcher(new ProxyAgent(proxyUrl));
}
