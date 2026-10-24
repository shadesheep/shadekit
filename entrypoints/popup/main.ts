import { createPinia } from 'pinia';
import { createApp } from 'vue';
import App from './App.vue';
import 'virtual:uno.css';
import '../shared/dark-mode.css';
import { initTheme } from '../shared/use-theme';

initTheme();

const app = createApp(App);
app.use(createPinia());
app.mount('#app');
