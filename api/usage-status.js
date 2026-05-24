import usageStatusHandler from '../functions/api/usage-status.js';
import { attachExpressLikeResponse, ensureQuery } from './_compat.js';

export default async function handler(req, res) {
  attachExpressLikeResponse(res);
  ensureQuery(req);
  return await usageStatusHandler(req, res);
}
