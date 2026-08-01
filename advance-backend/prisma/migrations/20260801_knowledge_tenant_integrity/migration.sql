-- Application authorization remains mandatory. These composite foreign keys
-- are the final database backstop: a bug can never connect a department,
-- resource, file, mutation, or parsed document across company boundaries.
CREATE UNIQUE INDEX IF NOT EXISTS "Department_id_companyId_key"
  ON "Department"("id", "companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeResource_id_companyId_key"
  ON "KnowledgeResource"("id", "companyId");
CREATE UNIQUE INDEX IF NOT EXISTS "KnowledgeFileAsset_id_companyId_key"
  ON "KnowledgeFileAsset"("id", "companyId");

ALTER TABLE "KnowledgeResource"
  ADD CONSTRAINT "KnowledgeResource_department_tenant_fkey"
  FOREIGN KEY ("departmentId", "companyId")
  REFERENCES "Department"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "KnowledgeMutation"
  ADD CONSTRAINT "KnowledgeMutation_department_tenant_fkey"
  FOREIGN KEY ("departmentId", "companyId")
  REFERENCES "Department"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeMutation_resource_tenant_fkey"
  FOREIGN KEY ("resourceId", "companyId")
  REFERENCES "KnowledgeResource"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeMutation_file_asset_tenant_fkey"
  FOREIGN KEY ("fileAssetId", "companyId")
  REFERENCES "KnowledgeFileAsset"("id", "companyId")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "KnowledgeFileAsset"
  ADD CONSTRAINT "KnowledgeFileAsset_resource_tenant_fkey"
  FOREIGN KEY ("knowledgeResourceId", "companyId")
  REFERENCES "KnowledgeResource"("id", "companyId")
  ON DELETE SET NULL ("knowledgeResourceId") ON UPDATE CASCADE;

ALTER TABLE "KnowledgeFileDocument"
  ADD CONSTRAINT "KnowledgeFileDocument_resource_tenant_fkey"
  FOREIGN KEY ("resourceId", "companyId")
  REFERENCES "KnowledgeResource"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "KnowledgeFileDocument_asset_tenant_fkey"
  FOREIGN KEY ("fileAssetId", "companyId")
  REFERENCES "KnowledgeFileAsset"("id", "companyId")
  ON DELETE CASCADE ON UPDATE CASCADE;
