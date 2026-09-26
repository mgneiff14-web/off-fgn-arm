// Função única da Vercel: atende tudo em /api/shop/* (catalog, event, create, status/live, webhook...).
import { createHandler } from '../../server/router.js';

export default createHandler();
