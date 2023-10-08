import { Link, Literal, Literals } from "expression/literal";
import { Filter, Filters } from "index/storage/filters";
import { FolderIndex } from "index/storage/folder";
import { InvertedIndex } from "index/storage/inverted";
import { IndexPrimitive, IndexQuery } from "index/types/index-query";
import { Indexable, LINKABLE_TYPE, LINKBEARING_TYPE, TAGGABLE_TYPE } from "index/types/indexable";
import { MetadataCache, Vault } from "obsidian";
import { MarkdownPage } from "./types/markdown";
import { extractSubtags, normalizeHeaderForLink } from "utils/normalizers";
import FlatQueue from "flatqueue";
import { FieldIndex } from "index/storage/fields";
import { FIELDBEARING_TYPE, Field, Fieldbearing } from "index/types/field";
import { FilterTrees, IndexResolver, Primitive, Scan, execute, optimizeQuery } from "index/storage/query-executor";

/** Central, index storage for datacore values. */
export class Datastore {
    /** The current store revision. */
    public revision: number;
    /**
     * Master collection of all object IDs. This is technically redundant with objects.keys() but this is a fast set
     * compared to an iterator.
     */
    private ids: Set<string>;
    /** The master collection of ALL indexed objects, mapping ID -> the object. */
    private objects: Map<string, Indexable>;
    /** Map parent object to it's direct child objects. */
    private children: Map<string, Set<string>>;

    // Indices for the various accepted query types. These will probably be moved to a different type later.
    /** Global map of object type -> list of all objects of that type. */
    private types: InvertedIndex<string>;
    /** Tracks exact tag occurence in objects. */
    private etags: InvertedIndex<string>;
    /** Tracks tag occurence in objects. */
    private tags: InvertedIndex<string>;
    /** Maps link strings to the object IDs that link to those links. */
    private links: InvertedIndex<string>;
    /** Tracks the existence of fields (indexed by normalized key name). */
    private fields: Map<string, FieldIndex>;
    /**
     * Quick searches for objects in folders. This index only tracks top-level objects - it is expanded recursively to
     * find child objects.
     */
    private folder: FolderIndex;

    public constructor(public vault: Vault, public metadataCache: MetadataCache) {
        this.revision = 0;
        this.ids = new Set();
        this.objects = new Map();
        this.children = new Map();

        this.types = new InvertedIndex();
        this.etags = new InvertedIndex();
        this.tags = new InvertedIndex();
        this.links = new InvertedIndex();
        this.fields = new Map();
        this.folder = new FolderIndex(vault);
    }

    /** Update the revision of the datastore due to an external update. */
    public touch() {
        this.revision += 1;
    }

    /** Load an object by ID. */
    public load(id: string): Indexable | undefined;
    /** Load a list of objects by ID. */
    public load(ids: string[]): Indexable[];

    load(id: string | string[]): Indexable | Indexable[] | undefined {
        if (Array.isArray(id)) {
            return id.map((a) => this.load(a)).filter((obj): obj is Indexable => obj !== undefined);
        }

        return this.objects.get(id);
    }

    /**
     * Store the given object, making it immediately queryable. Storing an object
     * takes ownership over it, and index-specific variables (prefixed via '$') may be
     * added to the object.
     */
    public store<T extends Indexable>(object: T | T[], substorer?: Substorer<T>) {
        this._recursiveStore(object, this.revision++, substorer, undefined);
    }

    /** Recursively store objects using a potential subindexer. */
    private _recursiveStore<T extends Indexable>(
        object: T | T[],
        revision: number,
        substorer?: Substorer<T>,
        parent?: Indexable
    ) {
        // Handle array inputs.
        if (Literals.isArray(object)) {
            for (let element of object) {
                this._recursiveStore(element, revision, substorer, parent);
            }

            return;
        }

        // Delete the previous instance of this object if present.
        // TODO: Probably only actually need to delete the root objects.
        this._deleteRecursive(object.$id);

        // Assign the next revision to this object; indexed objects are implied to be root objects.
        object.$revision = revision;
        object.$parent = parent;

        // Add the object to the appropriate object maps.
        this.ids.add(object.$id);
        this.objects.set(object.$id, object);

        // Add the object to the parent children map.
        if (parent) {
            if (!this.children.has(parent.$id)) this.children.set(parent.$id, new Set());
            this.children.get(parent.$id)!.add(object.$id);
        }

        this._index(object);

        // Index any subordinate objects in this object.
        substorer?.(object, (incoming, subindex) => this._recursiveStore(incoming, revision, subindex, object));
    }

    /** Delete an object by ID from the index, recursively deleting any child objects as well. */
    public delete(id: string): boolean {
        if (this._deleteRecursive(id)) {
            this.revision++;
            return true;
        }

        return false;
    }

    /** Internal method that does not bump the revision. */
    private _deleteRecursive(id: string): boolean {
        const object = this.objects.get(id);
        if (!object) {
            return false;
        }

        // Recursively delete all child objects.
        const children = this.children.get(id);
        if (children) {
            for (let child of children) {
                this._deleteRecursive(child);
            }

            this.children.delete(id);
        }

        // Drop this object from the appropriate maps.
        this._unindex(object);
        this.ids.delete(id);
        this.objects.delete(id);
        return true;
    }

    /** Add the given indexable to the appropriate indices. */
    private _index(object: Indexable) {
        this.types.set(object.$id, object.$types);

        // Exact and derived tags.
        if (object.$types.contains(TAGGABLE_TYPE) && iterableExists(object, "tags")) {
            const tags = object.tags as Set<string>;

            this.etags.set(object.$id, tags);
            this.tags.set(object.$id, extractSubtags(tags));
        }

        // Exact and derived links.
        if (object.$types.contains(LINKBEARING_TYPE) && iterableExists(object, "links")) {
            this.links.set(
                object.$id,
                (object.links as Link[]).map((link) => link.obsidianLink())
            );
        }

        // All fields on an object.
        if (object.$types.contains(FIELDBEARING_TYPE) && "fields" in object) {
            for (const field of object.fields as Iterable<Field>) {
                // Skip any index fields.
                if (field.key.startsWith("$")) continue;

                const norm = field.key.toLowerCase();
                if (!this.fields.has(norm)) this.fields.set(norm, new FieldIndex(false));

                this.fields.get(norm)!.add(object.$id, field.value);
            }
        }
    }

    /** Remove the given indexable from all indices. */
    private _unindex(object: Indexable) {
        this.types.delete(object.$id, object.$types);

        if (object.$types.contains(TAGGABLE_TYPE) && iterableExists(object, "tags")) {
            const tags = object.tags as Set<string>;

            this.etags.delete(object.$id, tags);
            this.tags.delete(object.$id, extractSubtags(tags));
        }

        if (object.$types.contains(LINKABLE_TYPE) && iterableExists(object, "links")) {
            // Assume links are normalized when deleting them. Could be broken but I hope not. We can always use a 2-way index to
            // fix this if we encounter non-normalized links.
            this.links.delete(
                object.$id,
                (object.links as Link[]).map((link) => link.obsidianLink())
            );
        }

        if (object.$types.contains(FIELDBEARING_TYPE) && "fields" in object) {
            for (const field of object.fields as Iterable<Field>) {
                // Skip any index fields.
                if (field.key.startsWith("$")) continue;

                const norm = field.key.toLowerCase();
                if (!this.fields.has(norm)) continue;

                this.fields.get(norm)!.delete(object.$id, field.value);
            }
        }
    }

    /** Completely clear the datastore of all values. */
    public clear() {
        this.ids.clear();
        this.objects.clear();
        this.children.clear();

        this.types.clear();
        this.tags.clear();
        this.etags.clear();
        this.links.clear();
        this.fields.clear();

        this.revision++;
    }

    /** Find the corresponding object for a given link. */
    public resolveLink(link: Link): Indexable | undefined {
        const file = this.objects.get(link.path);
        if (!file) return undefined;

        if (link.type === "file") return file;

        // Blocks and header links can only resolve inside of markdown files.
        if (!(file instanceof MarkdownPage)) return undefined;

        if (link.type === "header") {
            const section = file.sections.find(
                (sec) => normalizeHeaderForLink(sec.title) == link.subpath || sec.title == link.subpath
            );

            if (section) return section;
            else return undefined;
        } else if (link.type === "block") {
            for (const section of file.sections) {
                const block = section.blocks.find((bl) => bl.blockId === link.subpath);

                if (block) return block;
            }

            return undefined;
        } else {
            throw new Error(`Unrecognized link type: ${link.type}`);
        }
    }

    /**
     * Search the datastore for all documents matching the given query, returning them
     * as a list of indexed objects along with performance metadata.
     */
    public search(query: IndexQuery, context?: SearchContext): SearchResult<Indexable> {
        const start = Date.now();

        const filter = this._search(query, context);
        const result = Filters.resolve(filter, this.ids);

        const objects: Indexable[] = [];
        let maxRevision = 0;
        for (let id of result) {
            const object = this.objects.get(id);
            if (object) {
                objects.push(object);
                maxRevision = Math.max(maxRevision, object.$revision ?? 0);
            }
        }

        return {
            query: query,
            results: objects,
            duration: (Date.now() - start) / 1000.0,
            revision: maxRevision,
        };
    }

    /** Internal search which yields a filter of results. */
    private _search(query: IndexQuery, context?: SearchContext): Filter<string> {
        const resolver: IndexResolver<string> = {
            universe: this.ids,
            resolve: (leaf) => this._resolveLeaf(leaf, context),
        };

        return execute(optimizeQuery(query), resolver);
    }

    /** Resolve a leaf node in a search. */
    private _resolveLeaf(query: IndexPrimitive, context?: SearchContext): Primitive<string> | Scan<string> {
        return FilterTrees.primitive(this._resolvePrimitive(query, context));
    }

    /** Resolve leaf nodes in a search AST, yielding raw sets of results. */
    private _resolvePrimitive(query: IndexPrimitive, context?: SearchContext): Filter<string> {
        switch (query.type) {
            case "child-of":
                // TODO: Consider converting this to be a scan instead for a noticable speedup.
                const parents = this._search(query.parents, context);
                if (Filters.empty(parents)) {
                    return Filters.NOTHING;
                } else if (parents.type === "everything") {
                    if (query.inclusive) return Filters.EVERYTHING;

                    // Return the set all children. TODO: Consider caching via a `parents` map.
                    const allChildren = new Set<string>();
                    for (const element of this.objects.values()) {
                        if (element.$parent) allChildren.add(element.$id);
                    }

                    return Filters.atom(allChildren);
                }

                const resolvedParents = Filters.resolve(parents, this.ids);
                const childResults = new Set<string>(query.inclusive ? resolvedParents : []);

                for (const parent of resolvedParents) {
                    for (const child of this._iterateChildren(parent)) {
                        childResults.add(child);
                    }
                }

                return Filters.atom(childResults);
            case "parent-of":
                // TODO: Consider converting this to be a scan instead for a noticable speedup.
                const children = this._search(query.children, context);
                if (Filters.empty(children)) {
                    return Filters.NOTHING;
                } else if (children.type === "everything") {
                    if (query.inclusive) return Filters.EVERYTHING;

                    return Filters.atom(new Set(this.children.keys()));
                }

                const resolvedChildren = Filters.resolve(children, this.ids);
                const parentResults = new Set<string>(query.inclusive ? resolvedChildren : []);

                for (const child of resolvedChildren) {
                    for (const parent of this._iterateParents(child)) {
                        parentResults.add(parent);
                    }
                }

                return Filters.atom(parentResults);
            case "linked":
                if (query.distance && query.distance < 0) return Filters.NOTHING;

                // Compute the source objects first.
                const sources = this._search(query.source, context);
                if (Filters.empty(sources)) return Filters.NOTHING;
                else if (sources.type === "everything") {
                    if (query.inclusive) return Filters.EVERYTHING;
                    else return Filters.NOTHING;
                }

                const resolvedSources = Filters.resolve(sources, this.ids);
                const direction = query.direction ?? "both";
                const results = this._traverseLinked(resolvedSources, query.distance ?? 1, (id) =>
                    this._iterateAdjacentLinked(id, direction)
                );

                if (!query.inclusive) return Filters.atom(Filters.setIntersectNegation(results, resolvedSources));
                else return Filters.atom(results);
            case "constant":
                return Filters.constant(query.constant);
            case "id":
                const exactObject = this.objects.get(query.value);
                return exactObject ? Filters.atom(new Set([exactObject.$id])) : Filters.NOTHING;
            case "link":
                const resolvedPath = this.metadataCache.getFirstLinkpathDest(
                    query.value.path,
                    context?.sourcePath ?? ""
                )?.path;
                const resolved = resolvedPath ? query.value.withPath(resolvedPath) : query.value;

                const object = this.resolveLink(resolved);
                return object ? Filters.atom(new Set([object.$id])) : Filters.NOTHING;
            case "typed":
                return Filters.nullableAtom(this.types.get(query.value));
            case "tagged":
                if (query.exact) {
                    return Filters.nullableAtom(this.etags.get(query.value));
                } else {
                    return Filters.nullableAtom(this.tags.get(query.value));
                }
            case "path":
                let toplevel;
                if (query.exact) {
                    toplevel = this.folder.getExact(query.value);
                } else {
                    if (query.value == "" || query.value == "/") return Filters.EVERYTHING;

                    toplevel = this.folder.get(query.value);
                }

                if (toplevel.size == 0) return Filters.NOTHING;

                // Expand all children.
                const result = new Set(toplevel);
                for (let top of toplevel) {
                    for (let child of this._iterateChildren(top)) {
                        result.add(child);
                    }
                }

                return Filters.atom(result);
            case "field":
                const normkey = query.value.toLowerCase();
                const fieldIndex = this.fields.get(normkey);
                if (fieldIndex == null) return Filters.NOTHING;

                return Filters.atom(fieldIndex.all());
            case "equal-value":
                return this._filterFields(
                    query.field,
                    (index) => index.equals(query.value),
                    (field) => Literals.compare(query.value, field.value) == 0
                );
            case "bounded-value":
                // Compute the minimal lambda for checking if the value is in the given bounds.
                let lower: ((value: Literal) => boolean) | undefined = undefined;
                if (query.lower) {
                    const [lowerBound, inclusive] = query.lower;
                    if (inclusive) lower = (value: Literal) => Literals.compare(value, lowerBound) >= 0;
                    else lower = (value: Literal) => Literals.compare(value, lowerBound) > 0;
                }

                let upper: ((value: Literal) => boolean) | undefined = undefined;
                if (query.upper) {
                    const [upperBound, inclusive] = query.upper;
                    if (inclusive) upper = (value: Literal) => Literals.compare(value, upperBound) <= 0;
                    else upper = (value: Literal) => Literals.compare(value, upperBound) < 0;
                }

                let filter;
                if (lower && upper) filter = (field: Field) => lower!(field.value) && upper!(field.value);
                else if (lower) filter = (field: Field) => lower!(field.value);
                else if (upper) filter = (field: Field) => upper!(field.value);
                else
                    return this._filterFields(
                        query.field,
                        (index) => index.all(),
                        (field) => true
                    ); // no upper/lower bounds, return everything.

                // TODO: Implement smarter range queries later.
                return this._filterFields(query.field, (index) => undefined, filter);
        }
    }

    /** Filter documents by field values, using the fast lookup if it returns a result and otherwise filtering over every document using the slow predicate. */
    private _filterFields(
        key: string,
        fast: (index: FieldIndex) => Set<string> | undefined,
        slow: (field: Field) => boolean
    ) {
        const normkey = key.toLowerCase();
        const index = this.fields.get(normkey);
        if (index == null) return Filters.NOTHING;

        const fastlookup = fast(index);
        if (fastlookup != null) return Filters.atom(fastlookup);

        // Compute by iterating over each field.
        const matches = new Set<string>();
        for (const objectId of index.all()) {
            const object = this.objects.get(objectId);
            if (!object || !object.$types.contains(FIELDBEARING_TYPE)) continue;

            const field = (object as any as Fieldbearing).field(normkey);
            if (!field) continue;

            if (slow(field)) matches.add(objectId);
        }

        return Filters.atom(matches);
    }

    /**
     * Does Breadth-first Search to find all linked files within distance <distance>. This includes all source nodes,
     * so remove them afterwards if you do not want them.
     */
    private _traverseLinked(
        sourceIds: Set<string>,
        distance: number,
        adjacent: (id: string) => Iterable<string>
    ): Set<string> {
        if (distance < 0) return new Set();
        if (sourceIds.size == 0) return new Set();

        const visited = new Set<string>(sourceIds);

        const queue = new FlatQueue<string>();
        for (const element of sourceIds) queue.push(element, 0);

        while (queue.length > 0) {
            const dist = queue.peekValue()!;
            const element = queue.pop()!;

            for (const neighbor of adjacent(element)) {
                if (visited.has(neighbor)) continue;

                visited.add(neighbor);
                if (dist < distance) queue.push(neighbor, dist + 1);
            }
        }

        return visited;
    }

    /** Iterate all linked objects for the given object. */
    private *_iterateAdjacentLinked(id: string, direction: "incoming" | "outgoing" | "both"): Generator<string> {
        const object = this.objects.get(id);
        if (!object) return;

        if ((direction === "both" || direction === "incoming") && "link" in object && object["link"]) {
            const incoming = this.links.get((object.link as Link).obsidianLink());
            if (incoming) {
                for (const id of incoming) {
                    yield id;
                }
            }
        }

        if (
            (direction === "both" || direction === "outgoing") &&
            LINKBEARING_TYPE in object &&
            iterableExists(object, "links")
        ) {
            for (const link of object.links as Link[]) {
                const resolved = this.resolveLink(link);
                if (resolved) yield resolved.$id;
            }
        }
    }

    /** Iterator which produces all parents of the given object. */
    private *_iterateParents(child: string): Generator<string> {
        let object = this.objects.get(child);
        while (object && object?.$parent) {
            yield object.$parent.$id;
            object = object.$parent;
        }
    }

    /** Iterative which produces all children (recursively) of the given object. */
    private *_iterateChildren(parent: string): Generator<string> {
        const children = this.children.get(parent);
        if (children && children.size > 0) {
            for (let child of children) {
                yield child;
                yield* this._iterateChildren(child);
            }
        }
    }
}

/** A general function for storing sub-objects in a given object. */
export type Substorer<T extends Indexable> = (
    object: T,
    add: <U extends Indexable>(object: U | U[], subindex?: Substorer<U>) => void
) => void;

/** The result of searching given an index query. */
export interface SearchResult<O> {
    /** The query used to search. */
    query: IndexQuery;
    /** All of the returned results. */
    results: O[];
    /** The amount of time in seconds that the search took. */
    duration: number;
    /** The maximum revision of any document in the result, which is useful for diffing. */
    revision: number;
}

/** Extra settings that can be provided to a search. */
export interface SearchContext {
    /** The path to run from when resolving links and `this` sections. */
    sourcePath?: string;
}

/** Type guard which checks if object[key] exists and is an iterable. */
function iterableExists<T extends Record<string, any>, K extends string>(
    object: T,
    key: K
): object is T & Record<K, Iterable<any>> {
    return key in object && object[key] !== undefined && Symbol.iterator in object[key];
}
