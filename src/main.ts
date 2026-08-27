// Pixi generates uniform-upload functions with `new Function` by default, which needs
// `unsafe-eval` in the page's Content-Security-Policy. This module swaps those for a
// generic implementation that does not, so the policy can stay strict — see the CSP in
// `electron/app-protocol.cjs`. It has to be imported before any renderer is created.
import 'pixi.js/unsafe-eval';

import { mount } from 'svelte';

import './app.css';
import App from './App.svelte';

export default mount(App, { target: document.getElementById('app')! });
