import stringify from 'json-stable-stringify';
import { keyFieldsForTypeName } from './keyFields';
import { extractVariablesFromFieldName } from './fieldNames';

let shouldResetReducedQueries = false;

// A helper that adds/removes a cache object to/from an array, depending on whether the handler
// returns true or false. Reduces overhead.
const handleIncludeIf = (cache, item, previous, details) => (
    (condition, options = {}) => {
        const subjects = options.subjects || [item];
        const origin = options.origin || previous;

        if (subjects.length === 0) {
            return origin;
        }

        const keyFields = keyFieldsForTypeName(cache, subjects[0].__typename);
        const next = origin.filter((ref) => (
            subjects.some((subject) => (
                !keyFields.every((keyField) => (
                    details.readField(keyField, ref) === details.readField(keyField, subject)
                ))
            ))
        ));

        subjects.forEach((subject) => {
            const shouldInclude = typeof condition === 'function' ? condition(subject) : condition;

            if (shouldInclude) {
                next.push(details.toReference(subject));
            }
        });

        return next;
    }
);

const handleSetIf = (cache, item, itemRef, previous, details) => (
    (condition, options = {}) => {
        if (condition) {
            return itemRef;
        }

        const subject = options.subject || item;

        if (!subject) {
            return previous;
        }

        const keyFields = keyFieldsForTypeName(cache, subject.__typename);

        return keyFields.every((keyField) => details.readField(keyField, previous) === details.readField(keyField, subject))
            ? null
            : previous;
    }
);

const augmentFields = (cache, cacheObject, item, fields) => {
    const modify = (callback, previous, details) => {
        // Attach a couple additional helpers to apollo's standard details object.
        const itemRef = details.toReference(item);
        const callbackResult = callback({
            ...details,
            previous,
            item,
            itemRef,
            variables: extractVariablesFromFieldName(details.storeFieldName),
            includeIf: handleIncludeIf(cache, item, previous, details),
            setIf: handleSetIf(cache, item, itemRef, previous, details),
            cacheObject,
        });

        // Since the reduced queries are cached, they need to be notified when the DELETE sentinel
        // object is returned, so that a refetch happens if they include the deleted field. We set
        // the flag here and trigger the respective event after all modifiers have been handled.
        if (callbackResult === details.DELETE) {
            shouldResetReducedQueries = true;
        }

        return callbackResult;
    };

    if (typeof fields === 'function') {
        return (previous, details) => (
            modify(fields, previous, details)
        );
    }

    return Object.entries(fields).reduce((result, [field, modifier]) => ({
        ...result,
        [field]: (previous, details) => (
            modify(modifier, previous, details)
        ),
    }), {});
};

const getCacheIds = (cache, cacheData, item, cacheObject, typename) => {
    if (!cacheObject && !typename) {
        return ['ROOT_QUERY'];
    }

    if (cacheObject) {
        if (typeof cacheObject === 'function') {
            return [cache.identify(cacheObject(item))];
        }

        return [cache.identify(cacheObject)];
    }

    return Object.keys(cacheData).filter((key) => key.startsWith(`${typename}:`));
};

const handleEviction = (cache, cacheId) => {
    // Remove the specified cache object from the cache along with all references to it
    // on any other cache objects.
    cache.evict({ id: cacheId });
    cache.gc();
};

const handleNewFields = (cache, cacheData, cacheId, item, newFields) => {
    // Sometimes you might want to add fields to cache objects that do not exist yet in order to
    // avoid another server roundtrip to fetch data that your mutation already provides. `cache.modify`
    // can't do that (as the name suggests, you can only modify existing fields), and `cache.writeQuery`
    // is very verbose, so let's provide a compact way via a modifier.
    const dataToMerge = Object.entries(newFields).reduce((result, [fieldName, modifier]) => {
        const helpers = {
            toReference: cache.data.toReference,
            item,
            itemRef: cache.data.toReference(item),
            cacheObject: cacheData[cacheId],
        };

        if (typeof modifier === 'function') {
            return {
                ...result,
                [fieldName]: modifier(helpers),
            };
        }

        let variables;
        let storeFieldName = fieldName;

        if (modifier.variables) {
            variables = typeof modifier.variables === 'function'
                ? modifier.variables({ item })
                : modifier.variables;
            storeFieldName = `${fieldName}(${stringify(variables)})`;
        }

        return {
            ...result,
            [storeFieldName]: modifier.modify({
                ...helpers,
                variables,
            }),
        };
    }, {});

    cache.data.merge(cacheId, dataToMerge);
};

const handleFields = (cache, cacheData, cacheId, item, fields) => {
    try {
        cache.modify({
            id: cacheId,
            fields: augmentFields(cache, cacheData[cacheId], item, fields),
        });
    } catch (error) {
        // Cache errors are swallowed, so specifically output them to the console.
        /* eslint-disable-next-line no-console */
        console.error(error);
        throw error;
    }
};

const handleModifier = (cache, cacheData, item, modifier) => {
    const { cacheObject, typename, fields, newFields, evict } = modifier;
    const cacheIds = getCacheIds(cache, cacheData, item, cacheObject, typename);

    cacheIds.forEach((cacheId) => {
        if (evict) {
            handleEviction(cache, cacheId);
        }

        if (newFields) {
            handleNewFields(cache, cacheData, cacheId, item, newFields);
        }

        if (fields) {
            handleFields(cache, cacheData, cacheId, item, fields);
        }
    });
};

export const handleModifiers = (cache, item, modifiers) => {
    if (!modifiers) {
        return;
    }

    const cacheData = cache.extract();

    modifiers.forEach((modifier) => {
        if (typeof modifier === 'function') {
            if (!Array.isArray(item)) {
                throw new Error('Functional modifiers are only possible if your mutation returned an array');
            }

            item.forEach((arrayElement) => {
                handleModifier(cache, cacheData, arrayElement, modifier(arrayElement));
            });

            return;
        }

        handleModifier(cache, cacheData, item, modifier);
    });

    // If at least one modifier contained a field returning the DELETE sentinel object, cause all
    // active reduced queries to recompute, so that a refetch happens if they include the deleted field.
    if (shouldResetReducedQueries) {
        window.dispatchEvent(new Event('reset-reduced-queries'));
        shouldResetReducedQueries = false;
    }
};
