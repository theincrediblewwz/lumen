import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { ReaderApp } from './ReaderApp';
import { AiApp } from './AiApp';
import 'katex/dist/katex.min.css';
import './styles.css';
import './ui.css';
import './reader/reader.css';
import './components/ai.css';

// 独立阅读窗口通过 ?reader=1 复用同一 index.html（M4-4）
const params = new URLSearchParams(window.location.search);
const isReader = params.get('reader') === '1';
const isAi = params.get('ai') === '1';

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>{isAi ? <AiApp /> : isReader ? <ReaderApp /> : <App />}</React.StrictMode>,
);
