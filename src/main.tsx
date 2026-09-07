import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ReaderApp } from './ReaderApp';
import 'katex/dist/katex.min.css';
import './styles.css';
import './ui.css';
import './reader/reader.css';

// 独立阅读窗口通过 ?reader=1 复用同一 index.html（M4-4）
const isReader = new URLSearchParams(window.location.search).get('reader') === '1';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isReader ? <ReaderApp /> : <App />}</React.StrictMode>,
);
