import { Router } from 'express';

const modelsRouter = Router();

modelsRouter.get('/', (_req, res) => {
  res.json([
    { id: 'gpt-4o', name: 'GPT-4o' },
    { id: 'gpt-4o-mini', name: 'GPT-4o Mini' },
    { id: 'gpt-4-turbo', name: 'GPT-4 Turbo' },
    { id: 'gpt-3.5-turbo', name: 'GPT-3.5 Turbo' },
  ]);
});

export default modelsRouter;
