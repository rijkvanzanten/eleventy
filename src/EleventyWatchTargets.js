const { TemplatePath } = require("@11ty/eleventy-utils");
const { DepGraph } = require("dependency-graph");

const deleteRequireCache = require("./Util/DeleteRequireCache");
const JavaScriptDependencies = require("./Util/JavaScriptDependencies");

class EleventyWatchTargets {
  constructor() {
    this.targets = new Set();
    this.dependencies = new Set();
    this.newTargets = new Set();
    this._watchJavaScriptDependencies = true;

    this.graph = new DepGraph();
  }

  set watchJavaScriptDependencies(watch) {
    this._watchJavaScriptDependencies = !!watch;
  }

  get watchJavaScriptDependencies() {
    return this._watchJavaScriptDependencies;
  }

  isJavaScriptDependency(path) {
    return this.dependencies.has(path);
  }

  _normalizeTargets(targets) {
    if (!targets) {
      return [];
    } else if (Array.isArray(targets)) {
      return targets;
    }

    return [targets];
  }

  reset() {
    this.newTargets = new Set();
  }

  isWatched(target) {
    return this.targets.has(target);
  }

  addToDependencyGraph(parent, deps) {
    if (!this.graph.hasNode(parent)) {
      this.graph.addNode(parent);
    }
    for (let dep of deps) {
      if (!this.graph.hasNode(dep)) {
        this.graph.addNode(dep);
      }
      this.graph.addDependency(parent, dep);
    }
  }

  uses(parent, dep) {
    return this.getDependenciesOf(parent).includes(dep);
  }

  getDependenciesOf(parent) {
    if (!this.graph.hasNode(parent)) {
      return [];
    }
    return this.graph.dependenciesOf(parent);
  }

  addRaw(targets, isDependency) {
    for (let target of targets) {
      let path = TemplatePath.addLeadingDotSlash(target);
      if (!this.isWatched(path)) {
        this.newTargets.add(path);
      }

      this.targets.add(path);

      if (isDependency) {
        this.dependencies.add(path);
      }
    }
  }

  // add only a target
  add(targets) {
    targets = this._normalizeTargets(targets);
    this.addRaw(targets);
  }

  addAndMakeGlob(targets) {
    targets = this._normalizeTargets(targets).map((entry) =>
      TemplatePath.convertToRecursiveGlobSync(entry)
    );
    this.addRaw(targets);
  }

  // add only a target’s dependencies
  addDependencies(targets, filterCallback) {
    if (!this.watchJavaScriptDependencies) {
      return;
    }

    targets = this._normalizeTargets(targets);
    let deps = JavaScriptDependencies.getDependencies(targets);
    if (filterCallback) {
      deps = deps.filter(filterCallback);
    }

    for (let target of targets) {
      this.addToDependencyGraph(target, deps);
    }
    this.addRaw(deps, true);
  }

  setWriter(templateWriter) {
    this.writer = templateWriter;
  }

  clearDependencyRequireCache() {
    for (let path of this.dependencies) {
      deleteRequireCache(path);
    }
  }

  getNewTargetsSinceLastReset() {
    return Array.from(this.newTargets);
  }

  getTargets() {
    return Array.from(this.targets);
  }
}

module.exports = EleventyWatchTargets;
