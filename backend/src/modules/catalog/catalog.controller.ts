import type { Request, Response } from "express";
import {
  createProductForMerchant,
  findMerchantIdForUser,
  getMerchantById,
  getProductById,
  listProducts,
  updateProduct,
} from "./catalog.service";
import {
  fieldErrors,
  listProductsQuerySchema,
  parseTagQuery,
  productWriteSchema,
  uuidParamSchema,
} from "./catalog.schema";

export async function list(req: Request, res: Response): Promise<void> {
  const parsed = listProductsQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", fields: fieldErrors(parsed.error) });
    return;
  }

  const result = await listProducts({
    category: parsed.data.category,
    maxPrice: parsed.data.maxPrice,
    tags: parseTagQuery(parsed.data.tags),
    page: parsed.data.page,
    pageSize: parsed.data.pageSize,
    merchantId: parsed.data.merchantId,
  });

  res.status(200).json(result);
}

export async function getOne(req: Request, res: Response): Promise<void> {
  const id = uuidParamSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(404).json({ error: "NOT_FOUND" });
    return;
  }

  const product = await getProductById(id.data);
  if (!product) {
    res.status(404).json({ error: "NOT_FOUND" });
    return;
  }

  res.status(200).json(product);
}

export async function create(req: Request, res: Response): Promise<void> {
  const parsed = productWriteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", fields: fieldErrors(parsed.error) });
    return;
  }

  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const merchantId = await findMerchantIdForUser(userId);
  if (!merchantId) {
    res.status(403).json({ error: "FORBIDDEN" });
    return;
  }

  const product = await createProductForMerchant(merchantId, parsed.data);
  res.status(201).json(product);
}

export async function update(req: Request, res: Response): Promise<void> {
  const id = uuidParamSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(404).json({ error: "NOT_FOUND" });
    return;
  }

  const parsed = productWriteSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "VALIDATION_ERROR", fields: fieldErrors(parsed.error) });
    return;
  }

  const userId = req.user?.id;
  if (!userId) {
    res.status(401).json({ error: "UNAUTHORIZED" });
    return;
  }

  const merchantId = await findMerchantIdForUser(userId);
  if (!merchantId) {
    res.status(403).json({ error: "FORBIDDEN" });
    return;
  }

  const product = await updateProduct(id.data, merchantId, parsed.data);
  if (!product) {
    res.status(404).json({ error: "NOT_FOUND" });
    return;
  }

  res.status(200).json(product);
}

export async function getMerchant(req: Request, res: Response): Promise<void> {
  const id = uuidParamSchema.safeParse(req.params.id);
  if (!id.success) {
    res.status(404).json({ error: "NOT_FOUND" });
    return;
  }

  const merchant = await getMerchantById(id.data);
  if (!merchant) {
    res.status(404).json({ error: "NOT_FOUND" });
    return;
  }

  res.status(200).json(merchant);
}
