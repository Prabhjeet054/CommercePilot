import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/lib/auth-context";
import { CATEGORIES, productWriteSchema, type ProductWriteInput } from "@/lib/catalog-schema";

type Product = {
  id: string;
  merchantId: string;
  name: string;
  category: string;
  description: string | null;
  price: string;
  stock: number;
  rating: string | null;
  reviewCount: number;
  tags: string[];
  deliveryDays: number | null;
  imageUrl: string | null;
  attributes?: Array<{ attrKey: string; attrValue: string | null }>;
};

type AttributeRow = { attrKey: string; attrValue: string };

type FormValues = ProductWriteInput & { description: string };

const inputClass =
  "h-10 w-full rounded-md border border-input bg-background px-3 font-mono text-sm outline-none ring-ring focus-visible:ring-2";

const emptyForm: FormValues = {
  name: "",
  category: "Sports",
  description: "",
  price: 0,
  stock: 0,
  rating: undefined,
  reviewCount: undefined,
  deliveryDays: undefined,
  tags: "",
  imageUrl: undefined,
};

function parseAttributes(product: Product | null): AttributeRow[] {
  if (!product?.attributes?.length) {
    return [{ attrKey: "", attrValue: "" }];
  }
  return product.attributes.map((attribute) => ({
    attrKey: attribute.attrKey,
    attrValue: attribute.attrValue ?? "",
  }));
}

export default function ProductManagementPage() {
  const { user, authFetch, logout } = useAuth();
  const [products, setProducts] = useState<Product[]>([]);
  const [total, setTotal] = useState(0);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [attributes, setAttributes] = useState<AttributeRow[]>([{ attrKey: "", attrValue: "" }]);
  const [serverError, setServerError] = useState<string | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({ defaultValues: emptyForm });

  const merchantId = user?.merchantId ?? null;

  const title = useMemo(
    () => (editingId ? "Edit product" : "Create product"),
    [editingId],
  );

  async function refresh() {
    if (!merchantId) {
      setProducts([]);
      setTotal(0);
      return;
    }
    const response = await authFetch(
      `/products?merchantId=${encodeURIComponent(merchantId)}&page=1&pageSize=100`,
    );
    if (!response.ok) {
      setLoadError("Could not load products");
      return;
    }
    const body = (await response.json()) as { products: Product[]; total: number };
    setProducts(body.products);
    setTotal(body.total);
    setLoadError(null);
  }

  useEffect(() => {
    void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- refresh when merchant or token identity changes
  }, [merchantId]);

  function startCreate() {
    setEditingId(null);
    setAttributes([{ attrKey: "", attrValue: "" }]);
    reset(emptyForm);
    setServerError(null);
  }

  async function startEdit(productId: string) {
    const response = await authFetch(`/products/${productId}`);
    if (!response.ok) {
      setServerError("Could not load product");
      return;
    }
    const product = (await response.json()) as Product;
    setEditingId(product.id);
    setAttributes(parseAttributes(product));
    reset({
      name: product.name,
      category: product.category,
      description: product.description ?? "",
      price: Number(product.price),
      stock: product.stock,
      rating: product.rating ? Number(product.rating) : undefined,
      reviewCount: product.reviewCount,
      deliveryDays: product.deliveryDays ?? undefined,
      tags: product.tags.join(", "),
      imageUrl: product.imageUrl ?? undefined,
    });
    setServerError(null);
  }

  const onSubmit = handleSubmit(async (values) => {
    const parsed = productWriteSchema.safeParse(values);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const field = issue.path[0];
        if (typeof field === "string") {
          setError(field as keyof FormValues, { message: issue.message });
        }
      }
      return;
    }

    const payload = {
      name: parsed.data.name,
      category: parsed.data.category,
      description: parsed.data.description || null,
      price: parsed.data.price,
      stock: parsed.data.stock,
      rating: parsed.data.rating,
      reviewCount: parsed.data.reviewCount,
      deliveryDays: parsed.data.deliveryDays,
      tags: (parsed.data.tags ?? "")
        .split(",")
        .map((tag) => tag.trim())
        .filter(Boolean),
      imageUrl: parsed.data.imageUrl,
      attributes: attributes
        .filter((row) => row.attrKey.trim().length > 0)
        .map((row) => ({ attrKey: row.attrKey.trim(), attrValue: row.attrValue.trim() || null })),
    };

    setServerError(null);
    const response = await authFetch(editingId ? `/products/${editingId}` : "/products", {
      method: editingId ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as {
        error?: string;
        fields?: Record<string, string>;
      };
      setServerError(
        body.fields ? Object.values(body.fields)[0] ?? body.error ?? "Save failed" : (body.error ?? "Save failed"),
      );
      return;
    }

    startCreate();
    await refresh();
  });

  return (
    <main className="min-h-screen bg-background">
      <header className="flex items-center justify-between border-b border-border px-8 py-5">
        <div className="flex items-center gap-6">
          <Link to="/" className="font-mono text-xs tracking-[0.28em] text-muted-foreground">
            CP-CONSOLE
          </Link>
          <h1 className="text-lg font-semibold tracking-tight">Product management</h1>
          <Button asChild variant="ghost" size="sm">
            <Link to="/merchant">Growth</Link>
          </Button>
        </div>
        <div className="flex items-center gap-4">
          <span className="font-mono text-xs text-muted-foreground">{user?.email}</span>
          <Button type="button" variant="outline" size="sm" onClick={() => void logout()}>
            Sign out
          </Button>
        </div>
      </header>

      <section className="mx-auto grid max-w-6xl gap-8 px-8 py-10 lg:grid-cols-[1fr_22rem]">
        <div className="space-y-4">
          <div className="flex items-end justify-between">
            <p className="font-mono text-xs uppercase tracking-[0.24em] text-muted-foreground">
              {total} products
            </p>
            <Button type="button" variant="outline" size="sm" onClick={startCreate}>
              New product
            </Button>
          </div>

          {!merchantId && (
            <p className="rounded-md border border-border bg-card p-4 text-sm text-muted-foreground">
              This admin account is not linked to a merchant. Seeded demo admins can manage catalog
              rows; merchant records are created by the seed script.
            </p>
          )}
          {loadError && <p className="text-sm text-destructive">{loadError}</p>}

          <div className="overflow-x-auto rounded-lg border border-border">
            <table className="w-full text-left text-sm">
              <thead className="bg-secondary font-mono text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                <tr>
                  <th className="px-4 py-3 font-medium">Name</th>
                  <th className="px-4 py-3 font-medium">Category</th>
                  <th className="px-4 py-3 font-medium">Price</th>
                  <th className="px-4 py-3 font-medium">Stock</th>
                  <th className="px-4 py-3 font-medium">Tags</th>
                  <th className="px-4 py-3 font-medium" />
                </tr>
              </thead>
              <tbody>
                {products.map((product) => (
                  <tr key={product.id} className="border-t border-border">
                    <td className="px-4 py-3">{product.name}</td>
                    <td className="px-4 py-3 font-mono text-xs">{product.category}</td>
                    <td className="px-4 py-3 font-mono tabular-nums">₹{product.price}</td>
                    <td className="px-4 py-3 font-mono tabular-nums">{product.stock}</td>
                    <td className="px-4 py-3 text-xs text-muted-foreground">
                      {product.tags.join(", ") || "—"}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button type="button" variant="ghost" size="sm" onClick={() => void startEdit(product.id)}>
                        Edit
                      </Button>
                    </td>
                  </tr>
                ))}
                {products.length === 0 && merchantId && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-muted-foreground">
                      No products yet
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>

        <form onSubmit={onSubmit} className="space-y-4 rounded-lg border border-border bg-card p-6">
          <div>
            <p className="font-mono text-xs uppercase tracking-[0.32em] text-primary">{title}</p>
          </div>

          <label className="block space-y-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
              Name
            </span>
            <input className={inputClass} {...register("name")} />
            {errors.name && <p className="text-sm text-destructive">{errors.name.message}</p>}
          </label>

          <label className="block space-y-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
              Category
            </span>
            <select className={inputClass} {...register("category")}>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
            {errors.category && <p className="text-sm text-destructive">{errors.category.message}</p>}
          </label>

          <label className="block space-y-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
              Description
            </span>
            <textarea
              rows={3}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm outline-none ring-ring focus-visible:ring-2"
              {...register("description")}
            />
          </label>

          <div className="grid grid-cols-2 gap-3">
            <label className="block space-y-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
                Price (₹)
              </span>
              <input type="number" step="0.01" min="0" className={inputClass} {...register("price")} />
              {errors.price && <p className="text-sm text-destructive">{errors.price.message}</p>}
            </label>
            <label className="block space-y-2">
              <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
                Stock
              </span>
              <input type="number" step="1" min="0" className={inputClass} {...register("stock")} />
              {errors.stock && <p className="text-sm text-destructive">{errors.stock.message}</p>}
            </label>
          </div>

          <label className="block space-y-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
              Tags (comma separated)
            </span>
            <input className={inputClass} placeholder="cushioning, distance" {...register("tags")} />
          </label>

          <div className="space-y-2">
            <span className="font-mono text-[11px] uppercase tracking-[0.24em] text-muted-foreground">
              Attributes
            </span>
            {attributes.map((row, index) => (
              <div key={index} className="grid grid-cols-2 gap-2">
                <input
                  className={inputClass}
                  placeholder="key"
                  value={row.attrKey}
                  onChange={(event) => {
                    const next = [...attributes];
                    next[index] = { ...row, attrKey: event.target.value };
                    setAttributes(next);
                  }}
                />
                <input
                  className={inputClass}
                  placeholder="value"
                  value={row.attrValue}
                  onChange={(event) => {
                    const next = [...attributes];
                    next[index] = { ...row, attrValue: event.target.value };
                    setAttributes(next);
                  }}
                />
              </div>
            ))}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setAttributes([...attributes, { attrKey: "", attrValue: "" }])}
            >
              Add attribute
            </Button>
          </div>

          {serverError && <p className="text-sm text-destructive">{serverError}</p>}

          <Button type="submit" className="w-full" disabled={isSubmitting || !merchantId}>
            {isSubmitting ? "Saving…" : editingId ? "Update product" : "Create product"}
          </Button>
        </form>
      </section>
    </main>
  );
}
