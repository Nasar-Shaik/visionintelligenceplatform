/**
 * Application: user management (tenant-scoped via @vip/tenancy). Passwords are hashed before
 * persistence; the hash never leaves the domain. Listing/creation are gated by @vip/permissions
 * at the transport layer.
 */
import type { CreateUserInput, User } from '@vip/contracts';
import type { TenantScope, TenantRepository } from '@vip/tenancy';
import { hashPassword } from '@vip/auth';
import { MongoServerError } from 'mongodb';
import { newUser, toUser, type UserDoc } from '../domain/user.js';
import { conflict } from './errors.js';
import { nullPublisher, type EventPublisher } from './events.js';

const DUPLICATE_KEY = 11000;

export interface Clock {
  now(): Date;
}
export interface UserIdGen {
  userId(): string;
}

export interface UserServiceDeps {
  users: TenantRepository<UserDoc>;
  clock: Clock;
  ids: UserIdGen;
  publisher?: EventPublisher;
}

export class UserService {
  private readonly users: TenantRepository<UserDoc>;
  private readonly clock: Clock;
  private readonly ids: UserIdGen;
  private readonly publisher: EventPublisher;

  constructor(deps: UserServiceDeps) {
    this.users = deps.users;
    this.clock = deps.clock;
    this.ids = deps.ids;
    this.publisher = deps.publisher ?? nullPublisher;
  }

  async create(scope: TenantScope, input: CreateUserInput): Promise<User> {
    const passwordHash = await hashPassword(input.password);
    const doc = newUser(
      scope.tenantId,
      this.ids.userId(),
      input.email,
      passwordHash,
      input.roles,
      this.clock.now(),
    );
    try {
      await this.users.insertOne(scope, doc);
    } catch (err) {
      if (err instanceof MongoServerError && err.code === DUPLICATE_KEY) {
        throw conflict(`a user with email "${doc.email}" already exists in this tenant`);
      }
      throw err;
    }
    await this.publisher.publish({
      type: 'user.created',
      tenantId: scope.tenantId,
      payload: { userId: doc._id },
    });
    return toUser(doc);
  }

  async list(scope: TenantScope): Promise<User[]> {
    const docs = await this.users.findMany(scope, {});
    return docs.map((d) => toUser(d as UserDoc));
  }
}
