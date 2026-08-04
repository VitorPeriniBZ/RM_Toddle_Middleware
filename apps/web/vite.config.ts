import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * O client ID do Google NÃO vem de variável de ambiente aqui, de propósito.
 * Afrouxar o `envPrefix` do Vite para ler GOOGLE_CLIENT_ID arriscaria varrer
 * TODDLE_TOKEN e RM_WS_PASS para dentro do bundle. A UI busca o client ID em
 * GET /auth/config, que é público — o valor aparece no navegador de qualquer
 * forma.
 */
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // localhost e 127.0.0.1 são origens DIFERENTES para o Google. A porta 5173 e
    // as duas formas precisam estar nas "Origens JavaScript autorizadas".
    host: '127.0.0.1',
  },
});
