import { createApp } from 'vue';
import App from './App.vue';
import 'virtual:uno.css';
import '../shared/dark-mode.css';
import '../shared/config/config-page.css';
import { initTheme } from '../shared/use-theme';

initTheme();

const app = createApp(App);
app.mount('#app');
