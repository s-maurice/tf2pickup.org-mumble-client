import { tlsConnect } from './tls-connect';
import { MumbleSocket } from './mumble-socket';
import {
  delay,
  exhaustMap,
  filter,
  interval,
  lastValueFrom,
  map,
  race,
  switchMap,
  take,
  tap,
  throwError,
  zip,
} from 'rxjs';
import {
  Authenticate,
  PermissionQuery,
  Ping,
  Reject,
  ServerConfig,
  ServerSync, UserList_User,
  UserRemove,
  Version,
} from '@tf2pickup-org/mumble-protocol';
import { User } from './user';
import { ChannelManager } from './channel-manager';
import { UserManager } from './user-manager';
import { encodeMumbleVersion } from './encode-mumble-version';
import { ClientOptions } from './client-options';
import { ClientDisconnectedError, ConnectionRejectedError, UserNotRegisteredError } from './errors';
import { filterPacket } from './rxjs-operators/filter-packet';
import { platform, release } from 'os';
import { Permissions } from './permissions';
import { encodeMumbleVersionLegacy } from './encode-mumble-version-legacy';
import { TypedEventEmitter } from './typed-event-emitter';
import { Events } from './events';
import { getRegisteredUserList } from '@/commands';

const defaultOptions: Partial<ClientOptions> = {
  port: 64738,
  clientName: 'simple mumble bot',
  pingInterval: 10000,
};

export class Client extends TypedEventEmitter<Events, Events> {
  channels: ChannelManager = new ChannelManager(this);
  users: UserManager = new UserManager(this);
  serverVersion?: Version;
  serverConfig?: ServerConfig;
  user?: User;
  socket?: MumbleSocket;
  welcomeText?: string;
  readonly options: ClientOptions;

  // Channel permission cache
  readonly permissions = new Map<number, Permissions>();

  constructor(options: ClientOptions) {
    super();
    this.options = { ...defaultOptions, ...options };
  }

  /**
   * Establishes a connection to the provided Mumble server.
   */
  async connect(): Promise<this> {
    this.socket = new MumbleSocket(
      await tlsConnect(this.options.host, this.options.port, this.options),
    );
    this.emit('socketConnect', this.socket);

    this.socket.packet
      .pipe(
        filterPacket(PermissionQuery),
        filter(permissionQuery => permissionQuery.channelId !== undefined),
        map(permissionQuery => ({
          channelId: permissionQuery.channelId!,
          permissions: new Permissions(permissionQuery.permissions ?? 0),
        })),
      )
      .subscribe(({ channelId, permissions }) => {
        this.permissions.set(channelId, permissions);
      });

    this.socket.packet
      .pipe(
        filterPacket(UserRemove),
        filter(userRemove => userRemove.session === this.user?.session),
      )
      .subscribe(userRemove => {
        this.emit('disconnect', {
          reason: userRemove.reason,
        });
        this.socket = undefined;
      });

    const initialize: Promise<this> = lastValueFrom(
      race(
        zip(
          this.socket.packet.pipe(filterPacket(ServerSync), take(1)),
          this.socket.packet.pipe(filterPacket(ServerConfig), take(1)),
          this.socket.packet.pipe(filterPacket(Version), take(1)),
          this.socket.packet.pipe(filterPacket(Ping), take(1)),
        ).pipe(
          // Add one second delay before resolving the promise for good.
          // The issue is, in case of rejected connect, the mumble server will
          // send all the same packets (version, serverConfig, etc.) and send the
          // Reject packet at the very end.
          // FIXME Find a way to detect rejected connection without adding a delay
          delay(1000),
          tap(([serverSync, serverConfig, version]) => {
            if (serverSync.session) {
              this.user = this.users.bySession(serverSync.session);
            }
            this.welcomeText = serverSync.welcomeText;
            this.serverVersion = version;
            this.serverConfig = serverConfig;
            this.emit('connect');
            this.startPinger();
          }),
          map(() => this),
        ),
        this.socket.packet.pipe(
          filterPacket(Reject),
          switchMap(reject =>
            throwError(() => new ConnectionRejectedError(reject)),
          ),
        ),
      ),
    );

    await this.authenticate();
    await this.sendVersion();
    await this.ping();
    return await initialize;
  }

  /**
   * Disconnects from the server.
   */
  disconnect(): this {
    this.emit('disconnect');
    this.socket?.end();
    this.socket = undefined;
    return this;
  }

  /**
   * Retrieves the UserList_User (registered user list entry) with the matching name
   */
  async getRegisteredUserByName(name: string): Promise<UserList_User> {
    if (!this.socket) {
      throw new ClientDisconnectedError();
    }

    const userList = await getRegisteredUserList(this.socket);
    const userListUser = userList.users.find(u => u.name == name);

    if (!userListUser) {
      throw new UserNotRegisteredError(name);
    }

    return userListUser;
  }

  /**
   * @internal
   */
  private async sendVersion(): Promise<void> {
    const version = {
      major: 1,
      minor: 4,
      patch: 287,
    };
    return await this.socket?.send(
      Version,
      Version.create({
        release: this.options.clientName,
        versionV1: encodeMumbleVersionLegacy(version),
        versionV2: encodeMumbleVersion(version),
        os: platform(),
        osVersion: release(),
      }),
    );
  }

  /**
   * @internal
   */
  private async authenticate(): Promise<void> {
    return await this.socket?.send(
      Authenticate,
      Authenticate.create({
        username: this.options.username,
        password: this.options.password,
        tokens: this.options.tokens,
        opus: true,
      }),
    );
  }

  /**
   * @internal
   */
  private async ping() {
    return await this.socket?.send(Ping, Ping.create());
  }

  /**
   * @internal
   */
  private startPinger() {
    const subscription = interval(this.options.pingInterval)
      .pipe(exhaustMap(() => this.ping()))
      .subscribe();
    this.on('disconnect', () => subscription.unsubscribe());
  }
}
