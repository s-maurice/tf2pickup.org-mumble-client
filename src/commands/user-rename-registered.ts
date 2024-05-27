import { MumbleSocket } from '@/mumble-socket';
import { PermissionDenied, UserList, UserState } from '@tf2pickup-org/mumble-protocol';
import { concatMap, lastValueFrom, map, race, take, throwError, timeout } from 'rxjs';
import { filterPacket } from '@/rxjs-operators/filter-packet';
import { CommandTimedOutError, PermissionDeniedError } from '@';
import { CommandTimeout } from '@/config';

// renaming the user to an undefined name deletes the user registration
export const userRenameRegistered = async (
  socket: MumbleSocket,
  userId: number,
  name: string | undefined,
): Promise<void> => {
  const ret = lastValueFrom(
    race(
      socket.packet.pipe(
        filterPacket(UserState),
        take(1),
        map(() => void 0),
        timeout({
          first: CommandTimeout,
          with: () =>
            throwError(() => new CommandTimedOutError('userRegisterDelete')),
        }),
      ),
      socket.packet.pipe(
        filterPacket(PermissionDenied),
        take(1),
        concatMap(permissionDenied =>
          throwError(() => new PermissionDeniedError(permissionDenied)),
        ),
      ),
    ),
  );

  await socket.send(
    UserList,
    UserList.create({users: [{ userId, name: name }]}),
  );

  return ret;
};