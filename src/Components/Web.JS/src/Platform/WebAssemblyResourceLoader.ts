import { toAbsoluteUri } from '../Services/NavigationManager';
const networkFetchCacheMode = 'no-cache';

export class WebAssemblyResourceLoader {
  private usedCacheKeys: { [key: string]: boolean } = {};
  private networkLoads: { [name: string]: LoadLogEntry } = {};
  private cacheLoads: { [name: string]: LoadLogEntry } = {};

  static async initAsync(): Promise<WebAssemblyResourceLoader> {
    const bootConfigResponse = await fetch('_framework/blazor.boot.json', {
      method: 'GET',
      credentials: 'include',
      cache: networkFetchCacheMode
    });

    // Define a separate cache for each base href, so we're isolated from any other
    // Blazor application running on the same origin. We need this so that we're free
    // to purge from the cache anything we're not using and don't let it keep growing,
    // since we don't want to be worst offenders for space usage.
    const relativeBaseHref = document.baseURI.substring(document.location.origin.length);
    const cacheName = `blazor-resources-${relativeBaseHref}`;
    return new WebAssemblyResourceLoader(
      await bootConfigResponse.json(),
      await caches.open(cacheName));
  }

  constructor (public readonly bootConfig: BootJsonData, private cache: Cache)
  {
  }

  loadResources(resources: ResourceList, url: (name: string) => string): LoadingResource[] {
    return Object.keys(resources)
      .map(name => this.loadResource(name, url(name), resources[name]));
  }

  loadResource(name: string, url: string, contentHash: string): LoadingResource {
    // Setting 'cacheBootResources' to false bypasses the entire cache flow, including integrity checking.
    // This gives developers an easy opt-out if they don't like anything about the default cache mechanism.

    // There's also a Chromium bug we need to work around here: the CacheStorage APIs say that when
    // caches.open(name) returns a promise that succeeds, the value is meant to be a Cache instance.
    // However, if the browser was launched with a --user-data-dir param that's "too long" in some sense,
    // then even through the promise resolves as success, the value given is `undefined`.
    // See https://stackoverflow.com/a/46626574. We're reporting this to Chromium and others, but in
    // the meantime, if this.cache isn't set, just proceed without caching.
    const useCache = this.bootConfig.cacheBootResources && this.cache;

    const response = useCache
      ? this.loadResourceWithCaching(name, url, contentHash)
      : fetch(url, { cache: networkFetchCacheMode });
    return { name, url, response };
  }

  logToConsole() {
    const cacheLoadsEntries = Object.values(this.cacheLoads);
    const networkLoadsEntries = Object.values(this.networkLoads);
    const cacheResponseBytes = countTotalBytes(cacheLoadsEntries);
    const networkResponseBytes = countTotalBytes(networkLoadsEntries);
    const totalResponseBytes = cacheResponseBytes + networkResponseBytes;
    const linkerDisabledWarning = this.bootConfig.linkerEnabled ? '%c' : '\n%cThis application was built with linking (tree shaking) disabled. Published applications will be significantly smaller.';

    console.groupCollapsed(`%cblazor%c Loaded ${toDataSizeString(totalResponseBytes)} resources${linkerDisabledWarning}`, 'background: purple; color: white; padding: 1px 3px; border-radius: 3px;', 'font-weight: bold;', 'font-weight: normal;');

    if (cacheLoadsEntries.length) {
      console.groupCollapsed(`Loaded ${toDataSizeString(cacheResponseBytes)} resources from cache`);
      console.table(this.cacheLoads);
      console.groupEnd();
    }

    if (networkLoadsEntries.length) {
      console.groupCollapsed(`Loaded ${toDataSizeString(networkResponseBytes)} resources from network`);
      console.table(this.networkLoads);
      console.groupEnd();
    }

    console.groupEnd();
  }

  async purgeUnusedCacheEntriesAsync() {
    // We want to keep the cache small because, even though the browser will evict entries if it
    // gets too big, we don't want to be considered problematic by the end user viewing storage stats
    const cachedRequests = await this.cache.keys();
    const deletionPromises = cachedRequests.map(async cachedRequest => {
      if (!(cachedRequest.url in this.usedCacheKeys)) {
        await this.cache.delete(cachedRequest);
      }
    });

    return Promise.all(deletionPromises);
  }

  private async loadResourceWithCaching(name: string, url: string, contentHash: string) {
    // Since we are going to cache the response, we require there to be a content hash for integrity
    // checking. We don't want to cache bad responses. There should always be a hash, because the build
    // process generates this data.
    if (!contentHash || contentHash.length === 0) {
      throw new Error('Content hash is required');
    }

    const cacheKey = toAbsoluteUri(`${url}.${contentHash}`);
    this.usedCacheKeys[cacheKey] = true;

    const cachedResponse = await this.cache.match(cacheKey);
    if (cachedResponse) {
      // It's in the cache.
      const responseBytes = parseInt(cachedResponse.headers.get('content-length') || '0');
      this.cacheLoads[name] = { responseBytes };
      return cachedResponse;
    } else {
      // It's not in the cache. Fetch from network.
      const networkResponse = await fetch(url, { cache: networkFetchCacheMode, integrity: contentHash });
      this.addToCacheAsync(name, cacheKey, networkResponse); // Don't await - add to cache in background
      return networkResponse;
    }
  }

  private async addToCacheAsync(name: string, cacheKey: string, response: Response) {
    // We have to clone in order to put this in the cache *and* not prevent other code from
    // reading the original response stream.
    const responseData = await response.clone().arrayBuffer();

    // Now is an ideal moment to capture the performance stats for the request, since it
    // only just completed and is most likely to still be in the buffer. However this is
    // only done on a 'best effort' basis. Even if we do receive an entry, some of its
    // properties may be blanked out if it was a CORS request.
    const performanceEntry = getPerformanceEntry(response.url);
    const responseBytes = (performanceEntry && performanceEntry.encodedBodySize) || undefined;
    this.networkLoads[name] = { responseBytes };

    // Add to cache as a custom response object so we can track extra data such as responseBytes
    // We can't rely on the server sending content-length (ASP.NET Core doesn't by default)
    await this.cache.put(cacheKey, new Response(responseData, {
      headers: {
        'content-type': response.headers.get('content-type') || '',
        'content-length': (responseBytes || response.headers.get('content-length') || '').toString()
      }
    }));
  }
}

function countTotalBytes(loads: LoadLogEntry[]) {
  return loads.reduce((prev, item) => prev + (item.responseBytes || 0), 0);
}

function toDataSizeString(byteCount: number) {
  return `${(byteCount / (1024*1024)).toFixed(2)} MB`;
}

function getPerformanceEntry(url: string): PerformanceResourceTiming | undefined {
  if (typeof performance !== 'undefined') {
    return performance.getEntriesByName(url)[0] as PerformanceResourceTiming;
  }
}

// Keep in sync with bootJsonData in Microsoft.AspNetCore.Blazor.Build
interface BootJsonData {
  readonly entryAssembly: string;
  readonly resources: ResourceGroups;
  readonly debugBuild: boolean;
  readonly linkerEnabled: boolean;
  readonly cacheBootResources: boolean;
}

interface ResourceGroups {
  readonly wasm: ResourceList;
  readonly assembly: ResourceList;
  readonly pdb?: ResourceList;
}

interface LoadLogEntry {
  responseBytes: number | undefined;
}

export interface LoadingResource {
  name: string;
  url: string;
  response: Promise<Response>;
}

type ResourceList = { [name: string]: string };