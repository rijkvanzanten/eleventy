const DependencyGraph = require("dependency-graph").DepGraph;
const { isPlainObject } = require("@11ty/eleventy-utils");

const TemplateCollection = require("./TemplateCollection");
const EleventyErrorUtil = require("./EleventyErrorUtil");
const UsingCircularTemplateContentReferenceError = require("./Errors/UsingCircularTemplateContentReferenceError");
const debug = require("debug")("Eleventy:TemplateMap");
const debugDev = require("debug")("Dev:Eleventy:TemplateMap");

const EleventyBaseError = require("./EleventyBaseError");

class TemplateMapConfigError extends EleventyBaseError {}

class DuplicatePermalinkOutputError extends EleventyBaseError {
  get removeDuplicateErrorStringFromOutput() {
    return true;
  }
}

class TemplateMap {
  constructor(eleventyConfig) {
    if (!eleventyConfig) {
      throw new TemplateMapConfigError("Missing config argument.");
    }
    this.eleventyConfig = eleventyConfig;
    this.map = [];
    this.collectionsData = null;
    this.cached = false;
    this.configCollections = null;
    this.verboseOutput = true;
    this.collection = new TemplateCollection();
  }

  set userConfig(config) {
    this._userConfig = config;
  }

  get userConfig() {
    if (!this._userConfig) {
      // TODO use this.config for this, need to add collections to mergable props in userconfig
      this._userConfig = this.eleventyConfig.userConfig;
    }

    return this._userConfig;
  }

  get config() {
    if (!this._config) {
      this._config = this.eleventyConfig.getConfig();
    }
    return this._config;
  }

  get tagPrefix() {
    return "___TAG___";
  }

  async add(template) {
    // This is where the data is first generated for the template
    let data = await template.getData();

    for (let map of await template.getTemplateMapEntries(data)) {
      this.map.push(map);
    }
  }

  getMap() {
    return this.map;
  }

  getTagTarget(str) {
    if (str.startsWith("collections.")) {
      return str.slice("collections.".length);
    }
  }

  /* ---
   * pagination:
   *   data: collections
   * ---
   */
  isPaginationOverAllCollections(entry) {
    if (entry.data.pagination && entry.data.pagination.data) {
      return (
        entry.data.pagination.data === "collections" ||
        entry.data.pagination.data === "collections.all"
      );
    }
  }

  getPaginationTagTarget(entry) {
    if (entry.data.pagination && entry.data.pagination.data) {
      return this.getTagTarget(entry.data.pagination.data);
    }
  }

  getMappedDependencies() {
    let graph = new DependencyGraph();
    let tagPrefix = this.tagPrefix;

    graph.addNode(tagPrefix + "all");

    for (let entry of this.map) {
      if (this.isPaginationOverAllCollections(entry)) {
        continue;
      }

      // using Pagination (but not targeting a user config collection)
      let paginationTagTarget = this.getPaginationTagTarget(entry);
      if (paginationTagTarget) {
        if (this.isUserConfigCollectionName(paginationTagTarget)) {
          // delay this one to the second stage
          continue;
        } else {
          // using pagination but over a tagged collection
          graph.addNode(entry.inputPath);
          if (!graph.hasNode(tagPrefix + paginationTagTarget)) {
            graph.addNode(tagPrefix + paginationTagTarget);
          }
          graph.addDependency(entry.inputPath, tagPrefix + paginationTagTarget);
        }
      } else {
        // not using pagination
        graph.addNode(entry.inputPath);
      }

      if (!entry.data.eleventyExcludeFromCollections) {
        // collections.all
        graph.addDependency(tagPrefix + "all", entry.inputPath);

        if (entry.data.tags) {
          for (let tag of entry.data.tags) {
            let tagWithPrefix = tagPrefix + tag;
            if (!graph.hasNode(tagWithPrefix)) {
              graph.addNode(tagWithPrefix);
            }

            // collections.tagName
            // Dependency from tag to inputPath
            graph.addDependency(tagWithPrefix, entry.inputPath);
          }
        }
      }
    }

    return graph.overallOrder();
  }

  getDelayedMappedDependencies() {
    let graph = new DependencyGraph();
    let tagPrefix = this.tagPrefix;

    graph.addNode(tagPrefix + "all");

    let userConfigCollections = this.getUserConfigCollectionNames();

    // Add tags from named user config collections
    for (let tag of userConfigCollections) {
      graph.addNode(tagPrefix + tag);
      // graph.addDependency( tagPrefix + tag, tagPrefix + "all" );
    }

    for (let entry of this.map) {
      if (this.isPaginationOverAllCollections(entry)) {
        continue;
      }

      let paginationTagTarget = this.getPaginationTagTarget(entry);
      if (
        paginationTagTarget &&
        this.isUserConfigCollectionName(paginationTagTarget)
      ) {
        if (!graph.hasNode(entry.inputPath)) {
          graph.addNode(entry.inputPath);
        }
        graph.addDependency(entry.inputPath, tagPrefix + paginationTagTarget);

        if (!entry.data.eleventyExcludeFromCollections) {
          // collections.all
          graph.addDependency(tagPrefix + "all", entry.inputPath);

          if (entry.data.tags) {
            for (let tag of entry.data.tags) {
              let tagWithPrefix = tagPrefix + tag;
              if (!graph.hasNode(tagWithPrefix)) {
                graph.addNode(tagWithPrefix);
              }
              // collections.tagName
              // Dependency from tag to inputPath
              graph.addDependency(tagWithPrefix, entry.inputPath);
            }
          }
        }
      }
    }
    let order = graph.overallOrder();
    return order;
  }

  getPaginatedOverCollectionsMappedDependencies() {
    let graph = new DependencyGraph();
    let tagPrefix = this.tagPrefix;
    let allNodeAdded = false;

    for (let entry of this.map) {
      if (
        this.isPaginationOverAllCollections(entry) &&
        !this.getPaginationTagTarget(entry)
      ) {
        if (!allNodeAdded) {
          graph.addNode(tagPrefix + "all");
          allNodeAdded = true;
        }

        if (!graph.hasNode(entry.inputPath)) {
          graph.addNode(entry.inputPath);
        }

        if (!entry.data.eleventyExcludeFromCollections) {
          // collections.all
          graph.addDependency(tagPrefix + "all", entry.inputPath);
        }
      }
    }

    return graph.overallOrder();
  }

  getPaginatedOverAllCollectionMappedDependencies() {
    let graph = new DependencyGraph();
    let tagPrefix = this.tagPrefix;
    let allNodeAdded = false;

    for (let entry of this.map) {
      if (
        this.isPaginationOverAllCollections(entry) &&
        this.getPaginationTagTarget(entry) === "all"
      ) {
        if (!allNodeAdded) {
          graph.addNode(tagPrefix + "all");
          allNodeAdded = true;
        }

        if (!graph.hasNode(entry.inputPath)) {
          graph.addNode(entry.inputPath);
        }

        if (!entry.data.eleventyExcludeFromCollections) {
          // collections.all
          graph.addDependency(tagPrefix + "all", entry.inputPath);
        }
      }
    }

    return graph.overallOrder();
  }

  async setCollectionByTagName(tagName) {
    if (this.isUserConfigCollectionName(tagName)) {
      // async
      this.collectionsData[tagName] = await this.getUserConfigCollection(
        tagName
      );
    } else {
      this.collectionsData[tagName] = this.getTaggedCollection(tagName);
    }

    let precompiled = this.config.precompiledCollections;
    if (precompiled && precompiled[tagName]) {
      if (
        tagName === "all" ||
        !Array.isArray(this.collectionsData[tagName]) ||
        this.collectionsData[tagName].length === 0
      ) {
        this.collectionsData[tagName] = precompiled[tagName];
      }
    }
  }

  // TODO(slightlyoff): major bottleneck
  async initDependencyMap(dependencyMap) {
    let tagPrefix = this.tagPrefix;
    for (let depEntry of dependencyMap) {
      if (depEntry.startsWith(tagPrefix)) {
        // is a tag (collection) entry
        let tagName = depEntry.slice(tagPrefix.length);
        await this.setCollectionByTagName(tagName);
      } else {
        // is a template entry
        let map = this.getMapEntryForInputPath(depEntry);
        map._pages = await map.template.getTemplates(map.data);

        if (map._pages.length === 0) {
          // Setup serverlessUrls even if data set is 0 pages. This fixes 404 issue
          // with full build not including Sanity drafts but serverless render does
          // include Sanity drafts.

          // We want these empty-data pagination templates to show up in the serverlessUrlMap.
          map.template.initServerlessUrlsForEmptyPaginationTemplates(
            map.data.permalink
          );
        } else {
          let counter = 0;
          for (let page of map._pages) {
            // Copy outputPath to map entry
            if (!map.outputPath) {
              map.outputPath = page.outputPath;
            }

            if (
              counter === 0 ||
              (map.data.pagination &&
                map.data.pagination.addAllPagesToCollections)
            ) {
              if (!map.data.eleventyExcludeFromCollections) {
                // TODO do we need .template in collection entries?
                this.collection.add(page);
              }
            }
            counter++;
          }
        }
      }
    }
  }

  async cache() {
    debug("Caching collections objects.");
    this.collectionsData = {};

    for (let entry of this.map) {
      entry.data.collections = this.collectionsData;
    }

    let dependencyMap = this.getMappedDependencies();
    await this.initDependencyMap(dependencyMap);

    let delayedDependencyMap = this.getDelayedMappedDependencies();
    await this.initDependencyMap(delayedDependencyMap);

    let firstPaginatedDepMap =
      this.getPaginatedOverCollectionsMappedDependencies();
    await this.initDependencyMap(firstPaginatedDepMap);

    let secondPaginatedDepMap =
      this.getPaginatedOverAllCollectionMappedDependencies();
    await this.initDependencyMap(secondPaginatedDepMap);

    await this.resolveRemainingComputedData();

    let orderedPaths = this.getOrderedInputPaths(
      dependencyMap,
      delayedDependencyMap,
      firstPaginatedDepMap,
      secondPaginatedDepMap
    );
    let orderedMap = orderedPaths.map(
      function (inputPath) {
        return this.getMapEntryForInputPath(inputPath);
      }.bind(this)
    );

    await this.config.events.emitLazy("eleventy.contentMap", () => {
      return {
        inputPathToUrl: this.generateInputUrlContentMap(orderedMap),
        urlToInputPath: this.generateUrlMap(orderedMap),
      };
    });

    await this.populateContentDataInMap(orderedMap);

    this.populateCollectionsWithContent();
    this.cached = true;

    this.checkForDuplicatePermalinks();

    await this.config.events.emitLazy("eleventy.layouts", () =>
      this.generateLayoutsMap()
    );

    await this.config.events.emitLazy("eleventy.serverlessUrlMap", () =>
      this.generateServerlessUrlMap(orderedMap)
    );
  }

  generateInputUrlContentMap(orderedMap) {
    let entries = {};
    for (let entry of orderedMap) {
      entries[entry.inputPath] = entry._pages.map((entry) => entry.url);
    }
    return entries;
  }

  generateUrlMap(orderedMap) {
    let entries = {};
    for (let entry of orderedMap) {
      for (let page of entry._pages) {
        // duplicate urls throw an error, so we can return non array here
        entries[page.url] = entry.inputPath;
      }
    }
    return entries;
  }

  generateServerlessUrlMap(orderedMap) {
    let entries = [];
    for (let entry of orderedMap) {
      // Pagination templates with 0 pages should still populate
      // serverlessUrls into this event. We want these to still show up
      // in the inputPath to URL map and in the redirects.
      if (entry._pages.length === 0) {
        let serverless = {};
        if (isPlainObject(entry.data.permalink)) {
          // These are rendered in the template language!
          Object.assign(serverless, entry.template.getServerlessUrls());
          entries.push({
            inputPath: entry.inputPath,
            serverless,
          });
        }
      } else {
        for (let page of entry._pages) {
          let serverless = {};
          if (isPlainObject(page.data.permalink)) {
            // These are rendered in the template language!
            Object.assign(serverless, page.template.getServerlessUrls());

            entries.push({
              inputPath: entry.inputPath,
              serverless,
            });
          }
        }
      }
    }
    return entries;
  }

  // TODO(slightlyoff): hot inner loop?
  getMapEntryForInputPath(inputPath) {
    for (let map of this.map) {
      if (map.inputPath === inputPath) {
        return map;
      }
    }
  }

  getOrderedInputPaths(
    dependencyMap,
    delayedDependencyMap,
    firstPaginatedDepMap,
    secondPaginatedDepMap
  ) {
    let orderedMap = [];
    let tagPrefix = this.tagPrefix;

    for (let dep of dependencyMap) {
      if (!dep.startsWith(tagPrefix)) {
        orderedMap.push(dep);
      }
    }
    for (let dep of delayedDependencyMap) {
      if (!dep.startsWith(tagPrefix)) {
        orderedMap.push(dep);
      }
    }
    for (let dep of firstPaginatedDepMap) {
      if (!dep.startsWith(tagPrefix)) {
        orderedMap.push(dep);
      }
    }
    for (let dep of secondPaginatedDepMap) {
      if (!dep.startsWith(tagPrefix)) {
        orderedMap.push(dep);
      }
    }
    return orderedMap;
  }

  async populateContentDataInMap(orderedMap) {
    let usedTemplateContentTooEarlyMap = [];
    for (let map of orderedMap) {
      if (!map._pages) {
        throw new Error(`Content pages not found for ${map.inputPath}`);
      }
      if (!map.template.behavior.isRenderable()) {
        // Note that empty pagination templates will be skipped here as not renderable
        continue;
      }

      try {
        for (let pageEntry of map._pages) {
          pageEntry.templateContent =
            await pageEntry.template.renderWithoutLayout(pageEntry.data);
        }
      } catch (e) {
        if (EleventyErrorUtil.isPrematureTemplateContentError(e)) {
          usedTemplateContentTooEarlyMap.push(map);
        } else {
          throw e;
        }
      }
      debugDev(
        "Added this.map[...].templateContent, outputPath, et al for one map entry"
      );
    }

    for (let map of usedTemplateContentTooEarlyMap) {
      try {
        for (let pageEntry of map._pages) {
          pageEntry.templateContent =
            await pageEntry.template.renderWithoutLayout(pageEntry.data);
        }
      } catch (e) {
        if (EleventyErrorUtil.isPrematureTemplateContentError(e)) {
          throw new UsingCircularTemplateContentReferenceError(
            `${map.inputPath} contains a circular reference (using collections) to its own templateContent.`
          );
        } else {
          // rethrow?
          throw e;
        }
      }
    }
  }

  _testGetAllTags() {
    let allTags = {};
    for (let map of this.map) {
      let tags = map.data.tags;
      if (Array.isArray(tags)) {
        for (let tag of tags) {
          allTags[tag] = true;
        }
      }
    }
    return Object.keys(allTags);
  }

  getTaggedCollection(tag) {
    let result;
    if (!tag || tag === "all") {
      result = this.collection.getAllSorted();
    } else {
      result = this.collection.getFilteredByTag(tag);
    }
    debug(`Collection: collections.${tag || "all"} size: ${result.length}`);

    return result;
  }

  async _testGetTaggedCollectionsData() {
    let collections = {};
    collections.all = this.collection.getAllSorted();
    debug(`Collection: collections.all size: ${collections.all.length}`);

    let tags = this._testGetAllTags();
    for (let tag of tags) {
      collections[tag] = this.collection.getFilteredByTag(tag);
      debug(`Collection: collections.${tag} size: ${collections[tag].length}`);
    }
    return collections;
  }

  setUserConfigCollections(configCollections) {
    return (this.configCollections = configCollections);
  }

  isUserConfigCollectionName(name) {
    let collections =
      this.configCollections || this.userConfig.getCollections();
    return name && !!collections[name];
  }

  getUserConfigCollectionNames() {
    return Object.keys(
      this.configCollections || this.userConfig.getCollections()
    );
  }

  async getUserConfigCollection(name) {
    let configCollections =
      this.configCollections || this.userConfig.getCollections();

    // This works with async now
    let result = await configCollections[name](this.collection);

    debug(`Collection: collections.${name} size: ${result.length}`);
    return result;
  }

  async _testGetUserConfigCollectionsData() {
    let collections = {};
    let configCollections =
      this.configCollections || this.userConfig.getCollections();

    for (let name in configCollections) {
      collections[name] = configCollections[name](this.collection);

      debug(
        `Collection: collections.${name} size: ${collections[name].length}`
      );
    }

    return collections;
  }

  async _testGetAllCollectionsData() {
    let collections = {};
    let taggedCollections = await this._testGetTaggedCollectionsData();
    Object.assign(collections, taggedCollections);

    let userConfigCollections = await this._testGetUserConfigCollectionsData();
    Object.assign(collections, userConfigCollections);

    return collections;
  }

  populateCollectionsWithContent() {
    for (let collectionName in this.collectionsData) {
      // skip custom collections set in configuration files that have arbitrary types
      if (!Array.isArray(this.collectionsData[collectionName])) {
        continue;
      }

      for (let item of this.collectionsData[collectionName]) {
        // skip custom collections set in configuration files that have arbitrary types
        if (!isPlainObject(item) || !("inputPath" in item)) {
          continue;
        }

        let entry = this.getMapEntryForInputPath(item.inputPath);
        // This check skips precompiled collections
        if (entry) {
          let index = item.pageNumber || 0;
          let content = entry._pages[index]._templateContent;
          if (content !== undefined) {
            item.templateContent = content;
          }
        }
      }
    }
  }

  async resolveRemainingComputedData() {
    let promises = [];
    for (let entry of this.map) {
      for (let page of entry._pages) {
        if (this.config.keys.computed in page.data) {
          promises.push(page.template.resolveRemainingComputedData(page.data));
        }
      }
    }
    return Promise.all(promises);
  }

  generateLayoutsMap() {
    let layouts = {};

    for (let entry of this.map) {
      for (let page of entry._pages) {
        let tmpl = page.template;
        let layout = page.data[this.config.keys.layout];
        if (layout) {
          let layoutFilePath = tmpl.getLayout(layout)?.inputPath;
          if (!layouts[layoutFilePath]) {
            layouts[layoutFilePath] = new Set();
          }
          layouts[layoutFilePath].add(page.inputPath);
        }
      }
    }

    for (let key in layouts) {
      layouts[key] = Array.from(layouts[key]);
    }

    return layouts;
  }

  checkForDuplicatePermalinks() {
    let permalinks = {};
    let warnings = {};
    for (let entry of this.map) {
      for (let page of entry._pages) {
        if (page.outputPath === false || page.url === false) {
          // do nothing (also serverless)
        } else if (!permalinks[page.outputPath]) {
          permalinks[page.outputPath] = [entry.inputPath];
        } else {
          warnings[
            page.outputPath
          ] = `Output conflict: multiple input files are writing to \`${
            page.outputPath
          }\`. Use distinct \`permalink\` values to resolve this conflict.
  1. ${entry.inputPath}
${permalinks[page.outputPath]
  .map(function (inputPath, index) {
    return `  ${index + 2}. ${inputPath}\n`;
  })
  .join("")}
`;

          permalinks[page.outputPath].push(entry.inputPath);
        }
      }
    }

    let warningList = Object.values(warnings);
    if (warningList.length) {
      // throw one at a time
      throw new DuplicatePermalinkOutputError(warningList[0]);
    }
  }

  async _testGetCollectionsData() {
    if (!this.cached) {
      await this.cache();
    }

    return this.collectionsData;
  }
}

module.exports = TemplateMap;
