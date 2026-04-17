import type { RBush3D } from 'rbush-3d/dist';
import type { UUID } from '../UUID';
import type { GameObject } from '../public/GameObject';
import type { GetObjectsOptions } from '../commands/RegionCommands';
import type { Region } from '../Region';

export interface IObjectStore
{
    rtree?: RBush3D;
    setRegion: (region: Region) => void;
    populateChildren: (obj: GameObject) => void;
    getObjectsByParent: (parentID: number) => GameObject[];
    shutdown: () => void;
    getObjectsInArea: (minX: number, maxX: number, minY: number, maxY: number, minZ: number, maxZ: number) => GameObject[];
    getObjectByUUID: (fullID: UUID | string) => GameObject;
    getObjectByLocalID: (ID: number) => GameObject;
    getNumberOfObjects: () => number;
    getAllObjects: (options: GetObjectsOptions) => GameObject[];
    forEachObject: (fn: (obj: GameObject, localId: number) => void) => void;
    setPersist: (persist: boolean) => void;
}
