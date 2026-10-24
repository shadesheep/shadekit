import { createApp } from 'vue';
import App from './App.vue';
import 'virtual:uno.css';
import '../shared/dark-mode.css';
import '../shared/page-styles.scss';
import { initTheme } from '../shared/use-theme';

initTheme();

createApp(App).mount('#app');
