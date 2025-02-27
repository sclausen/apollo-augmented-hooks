import stringify from 'json-stable-stringify';

// Apollo offers no streamlined way to extract the query variables for the cache object we are
// modifying, so this helper has to exist.
export const extractVariablesFromFieldName = (fieldName) => {
    const variableString = (
        fieldName.match(/\((.+)\)/)?.[1]
        || fieldName.match(/:(.+)/)?.[1]
    );

    return variableString ? JSON.parse(variableString) : null;
};

export const buildFieldName = (selection, variables) => {
    if (!selection.arguments?.length) {
        return selection.name.value;
    }

    const args = selection.arguments.reduce((result, { name, value }) => ({
        ...result,
        // Handle both inline and external veriables
        [name.value]: value.value || variables?.[value.name.value],
    }), {});

    // The field names in apollo's in-memory-cache are built like this:
    //
    // someField
    // someField({"someParam":"someValue"})
    //
    // If there are multiple arguments, they are sorted alphabetically, which is why we use
    // json-stable-stringify here (which guarantees alphabetical order).
    return `${selection.name.value}(${stringify(args)})`;
};
