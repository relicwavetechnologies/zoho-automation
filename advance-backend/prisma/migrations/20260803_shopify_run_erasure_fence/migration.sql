CREATE TABLE "ShopifyRunErasureFence" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ShopifyRunErasureFence_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopifyRunErasureFence_companyId_sourceId_key"
ON "ShopifyRunErasureFence"("companyId", "sourceId");

CREATE INDEX "ShopifyRunErasureFence_createdAt_idx"
ON "ShopifyRunErasureFence"("createdAt");

ALTER TABLE "ShopifyRunErasureFence"
ADD CONSTRAINT "ShopifyRunErasureFence_companyId_fkey"
FOREIGN KEY ("companyId") REFERENCES "Company"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
