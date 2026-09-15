import { Injectable } from '@nestjs/common';
import type { IdentityReader, MeView } from './contract.js';
import { tenantContext } from './tenant-context.js';
import { TenantDb } from './tenant-db.js';

@Injectable()
export class PrismaIdentityReader implements IdentityReader {
  constructor(private readonly db: TenantDb) {}

  async findMe(): Promise<MeView | null> {
    const { userId } = tenantContext.require();

    return this.db.run(async (tx) => {
      const user = await tx.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          name: true,
          email: true,
          role: true,
          org: { select: { id: true, name: true, logoUrl: true } },
        },
      });

      // No org_id filter here, and none is needed: the policy applied to this
      // transaction means a user from another organization is not visible, so
      // this returns null exactly as it would for an id that does not exist.
      return user === null
        ? null
        : {
            userId: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            org: user.org,
          };
    });
  }
}
