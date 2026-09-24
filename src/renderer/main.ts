import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import './styles.css'
import './types'

createApp(App).use(createPinia()).mount('#app')
