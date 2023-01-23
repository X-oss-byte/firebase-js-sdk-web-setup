/**
 * @license
 * Copyright 2023 Google LLC
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *   http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import {createWatchStream, TargetSnapshot, WatchStream} from './watch_stream';
import {DocumentUtil} from './document_util';
import {
  assertDeepEqual,
  descriptionFromSortedStrings,
  documentIdFromDocumentPath
} from './util';

import { AutoId } from '../../src/util/misc';
import { decodeBase64 } from '../../src/platform/base64';
import { BloomFilter } from '../../src/remote/bloom_filter';
import {ExistenceFilter} from '../../src/protos/firestore_proto_api';
import {DocumentReference} from '../../src/api/reference';
import {Firestore} from '../../src/api/database';

const DOCUMENT_DATA_KEY = "BloomFilterWatchTest_GroupId";

class InvalidRunTestOptionsError extends Error {
  readonly name = "InvalidRunTestOptionsError";
}

export async function runTest(db: Firestore, projectId: string, host: string, ssl: boolean, documentCreateCount_: number | null, documentDeleteCount_: number | null, collectionId_: string | null, log: (...args: Array<any>) => any): Promise<void> {
  log("Bloom Filter Watch Test Started");

  const collectionId = collectionId_ ?? `bloom_filter_watch_test_${AutoId.newId()}`;
  const documentCreateCount = documentCreateCount_ ?? 10;
  const documentDeleteCount = documentDeleteCount_ ?? Math.ceil(documentCreateCount / 2);

  if (documentDeleteCount > documentCreateCount) {
    throw new InvalidRunTestOptionsError(
      `documentDeleteCount (${documentDeleteCount}) must be ` +
      `less than or equal to documentCreateCount (${documentCreateCount})`);
  }

  log(`Creating WatchStream with projectId=${projectId} and host=${host}`);
  const watchStream = createWatchStream(projectId, host, ssl);
  const testRunner = new BloomFilterWatchTest(db, watchStream, projectId, host, ssl, documentCreateCount, documentDeleteCount, collectionId, log);
  await watchStream.open();
  try {
    await testRunner.run();
  } finally {
    log("Closing watch stream");
    await watchStream.close();
  }

  log("Bloom Filter Watch Test Completed Successfully");
}

class BloomFilterWatchTest {

  private readonly documentUtil: DocumentUtil;
  private readonly uniqueId: string;

  constructor(
    readonly db: Firestore,
    readonly watchStream: WatchStream,
    readonly projectId: string,
    readonly host: string,
    readonly ssl: boolean,
    readonly documentCreateCount: number,
    readonly documentDeleteCount: number,
    readonly collectionId: string,
    readonly log: (...args: Array<any>) => any) {
      this.documentUtil = new DocumentUtil(db, collectionId);
      this.uniqueId = AutoId.newId();
  }

  async run(): Promise<void> {
    const createdDocumentRefs = await this.createDocuments();

    const snapshot = await this.startTarget();
    assertDocumentsInSnapshot(snapshot, createdDocumentRefs);

    const documentRefsToDelete = createdDocumentRefs.slice(createdDocumentRefs.length - this.documentDeleteCount);
    await this.deleteDocuments(documentRefsToDelete);

    await this.pause(10);
    await this.resumeWatchStream(snapshot);
  }

  private async createDocuments(): Promise<Array<DocumentReference>> {
    this.log(`Creating ${this.documentCreateCount} documents in collection ${this.collectionId}`);
    const createdDocumentRefs = await this.documentUtil.createDocuments(this.documentCreateCount, {[DOCUMENT_DATA_KEY]: this.uniqueId});
    const createdDocumentIds = createdDocumentRefs.map(documentRef => documentRef.id);
    this.log(`Created ${this.documentCreateCount} documents ` +
      `in collection ${this.collectionId}: ` +
      descriptionFromSortedStrings(createdDocumentIds));
    return createdDocumentRefs;
  }

  private async deleteDocuments(documentRefsToDelete: Array<DocumentReference>): Promise<void> {
    const documentIdsToDelete = documentRefsToDelete.map(documentRef => documentRef.id);
    this.log(`Deleting ${documentRefsToDelete.length} documents: ` +
      descriptionFromSortedStrings(documentIdsToDelete));
    await this.documentUtil.deleteDocuments(documentRefsToDelete);
    this.log(`Deleted ${documentRefsToDelete.length} documents`);
  }

  private pause(numSecondsToPause: number): Promise<void> {
    this.log(`Pausing for ${numSecondsToPause} seconds.`);
    return new Promise(resolve => setTimeout(resolve, numSecondsToPause * 1000));
  }

  private async startTarget(): Promise<TargetSnapshot> {
    this.log("Adding target to watch stream");
    await this.watchStream.addTarget({
      targetId: 1,
      projectId: this.projectId,
      collectionId: this.collectionId,
      keyFilter: DOCUMENT_DATA_KEY,
      valueFilter: this.uniqueId,
    });

    this.log("Waiting for a snapshot from watch");
    const snapshot = await this.watchStream.getInitialSnapshot(1);
    const documentNames = Array.from(snapshot.documentPaths).sort();
    const documentIds = documentNames.map(documentIdFromDocumentPath);
    this.log(`Got snapshot with ${documentIds.length} documents: ${descriptionFromSortedStrings(documentIds)}`);

    this.log("Removing target from watch stream");
    await this.watchStream.removeTarget(1);

    return snapshot;
  }

  private async resumeWatchStream(snapshot: TargetSnapshot, options?: { expectedCount?: number }): Promise<void> {
    const expectedCount = options?.expectedCount ?? snapshot.documentPaths.size;
    this.log(`Resuming target in watch stream with expectedCount=${expectedCount}`);
    await this.watchStream.addTarget({
      targetId: 2,
      projectId: this.projectId,
      collectionId: this.collectionId,
      keyFilter: DOCUMENT_DATA_KEY,
      valueFilter: this.uniqueId,
      resume: {
        from: snapshot,
        expectedCount
      }
    });

    this.log("Waiting for an existence filter from watch");
    const existenceFilterPromise = this.watchStream.getExistenceFilter(2);
    const snapshotPromise = this.watchStream.getInitialSnapshot(2);
    const result = (await Promise.race([existenceFilterPromise, snapshotPromise])) as unknown;

    if (result instanceof TargetSnapshot) {
      this.log("Didn't get an existence filter");
    } else {
      this.log(`Got an existence filter: ${JSON.stringify(result, null, 2)}`);
      const bloomFilterNumBits = getBloomFilterNumBits(result as ExistenceFilter);
      if (bloomFilterNumBits !== null) {
        this.log(`Bloom filter size, in bits: ${bloomFilterNumBits}`);
      }
    }

    this.log("Waiting for a snapshot from watch");
    const snapshot2 = await snapshotPromise;
    const documentNames2 = Array.from(snapshot2.documentPaths).sort();
    const documentIds2 = documentNames2.map(documentIdFromDocumentPath);
    this.log(`Got snapshot with ${documentIds2.length} documents: ${descriptionFromSortedStrings(documentIds2)}`);
  }
}

function getBloomFilterNumBits(existenceFilter: ExistenceFilter): number | null {
  if (existenceFilter?.unchangedNames === undefined) {
    return null;
  }
  const bitmap = existenceFilter.unchangedNames.bits?.bitmap ?? '';
  const padding = existenceFilter.unchangedNames.bits?.padding ?? 0;
  if (padding < 0 || padding > 7) {
    return null;
  }
  return (bitmap.length * 8) - padding;
}

function assertDocumentsInSnapshot(snapshot: TargetSnapshot, expectedDocuments: Array<DocumentReference>): void {
  const actualDocumentPathsSorted = Array.from(snapshot.documentPaths.values()).map(documentIdFromDocumentPath).sort();
  const expectedDocumentPathsSorted = expectedDocuments.map(documentRef => documentRef.id).sort();
  assertDeepEqual(actualDocumentPathsSorted, expectedDocumentPathsSorted);
}

