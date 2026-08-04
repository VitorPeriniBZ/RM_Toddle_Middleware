import { createRoot } from 'react-dom/client';
import { App } from './App';

const raiz = document.getElementById('root');
if (!raiz) throw new Error('#root não encontrado no index.html');
createRoot(raiz).render(<App />);
