using System.Collections;
using System.Reflection;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.Json.Serialization.Metadata;

namespace MassiveScale.Testing;

/// <summary>
/// Puts every model and enum a generated client declares through the client's own serializer
/// settings, so a contract System.Text.Json rejects (two properties with one JSON name, a converter
/// that does not fit its property, a broken discriminator) fails here rather than on the first
/// request in production.
/// </summary>
public static class ContractSmoke
{
    private const BindingFlags AnyInstance = BindingFlags.Public | BindingFlags.NonPublic | BindingFlags.Instance;

    private const int MaxDepth = 3;

    /// <summary>
    /// Checks every generated record and enum in an assembly, with the serializer settings its
    /// <c>ClientRuntime</c> creates.
    /// </summary>
    /// <param name="assembly">An assembly built from the emitter's output.</param>
    /// <returns>The names of the types checked, and one message per failure.</returns>
    public static (IReadOnlyList<string> Checked, IReadOnlyList<string> Failures) Check(Assembly assembly)
    {
        var runtime = assembly.GetTypes().FirstOrDefault(t => t.Name == "ClientRuntime")
            ?? throw new InvalidOperationException($"{assembly.GetName().Name} has no ClientRuntime.");
        var options = (JsonSerializerOptions)runtime
            .GetMethod("CreateJsonOptions", BindingFlags.NonPublic | BindingFlags.Static)!
            .Invoke(null, [null])!;
        return Check(assembly.GetTypes().Where(t => !t.IsNested), options);
    }

    /// <summary>
    /// Checks the records and generated enums among some types.
    /// </summary>
    /// <param name="types">The candidate types; anything that is not a record or generated enum is skipped.</param>
    /// <param name="options">The serializer settings to check them with.</param>
    /// <returns>The names of the types checked, and one message per failure.</returns>
    public static (IReadOnlyList<string> Checked, IReadOnlyList<string> Failures) Check(
        IEnumerable<Type> types, JsonSerializerOptions options)
    {
        var failures = new List<string>();
        var checkedTypes = new List<string>();
        foreach (var type in types)
        {
            if (IsGeneratedRecord(type))
            {
                var closed = Close(type);
                checkedTypes.Add(type.Name);
                Run(failures, closed, () => CheckRecord(closed, options));
            }
            else if (IsGeneratedEnum(type))
            {
                checkedTypes.Add(type.Name);
                Run(failures, type, () => CheckEnum(type, options));
            }
        }

        return (checkedTypes, failures);
    }

    /// <summary>Runs one check, recording what it threw against the type.</summary>
    private static void Run(List<string> failures, Type type, Action check)
    {
        try
        {
            check();
        }
        catch (Exception e)
        {
            var inner = e is TargetInvocationException { InnerException: { } cause } ? cause : e;
            failures.Add($"{type}: {inner.GetType().Name}: {inner.Message}");
        }
    }

    /// <summary>Whether a type is a record the emitter generated (records have an <c>EqualityContract</c>).</summary>
    private static bool IsGeneratedRecord(Type type) =>
        type.IsClass
        && type.GetProperty("EqualityContract", AnyInstance) is not null
        && type.GetCustomAttribute<System.Runtime.CompilerServices.CompilerGeneratedAttribute>() is null;

    /// <summary>Whether a type is an enum the emitter generated, which carries its own converter.</summary>
    private static bool IsGeneratedEnum(Type type) =>
        type.IsEnum && type.GetCustomAttribute<JsonConverterAttribute>() is not null;

    /// <summary>Closes a generic record over <see cref="string"/>, so it can be built and serialized.</summary>
    private static Type Close(Type type) =>
        type.IsGenericTypeDefinition
            ? type.MakeGenericType(type.GetGenericArguments().Select(_ => typeof(string)).ToArray())
            : type;

    /// <summary>
    /// Builds the record's contract, then round-trips a filled instance (or, for an abstract
    /// base, each of its subtypes through the base type).
    /// </summary>
    private static void CheckRecord(Type type, JsonSerializerOptions options)
    {
        var info = options.GetTypeInfo(type);

        if (info.PolymorphismOptions is { } polymorphism)
        {
            foreach (var derived in polymorphism.DerivedTypes)
            {
                var value = Sample(derived.DerivedType, 0)!;
                var json = JsonSerializer.Serialize(value, type, options);
                var read = JsonSerializer.Deserialize(json, type, options);
                if (read?.GetType() != derived.DerivedType)
                {
                    throw new InvalidOperationException(
                        $"{derived.DerivedType.Name} sent as {type.Name} was read back as {read?.GetType().Name ?? "null"}: {json}");
                }
            }
        }

        if (!type.IsAbstract) RoundTrip(type, Sample(type, 0), options);
    }

    /// <summary>Round-trips every declared member of an enum.</summary>
    private static void CheckEnum(Type type, JsonSerializerOptions options)
    {
        foreach (var value in Enum.GetValues(type))
        {
            RoundTrip(type, value, options);
        }
    }

    /// <summary>
    /// Writes a value, reads it back, and writes it again, failing unless both writes are the same.
    /// </summary>
    private static void RoundTrip(Type type, object? value, JsonSerializerOptions options)
    {
        var json = JsonSerializer.Serialize(value, type, options);
        var again = JsonSerializer.Serialize(JsonSerializer.Deserialize(json, type, options), type, options);
        if (json != again)
        {
            throw new InvalidOperationException($"did not round-trip: wrote {json}, then {again}");
        }
    }

    /// <summary>
    /// A value of a type with something in every property, so each converter and wire name is
    /// exercised. Deeper than <see cref="MaxDepth"/>, a model is left null to stop recursion.
    /// </summary>
    private static object? Sample(Type type, int depth)
    {
        var underlying = Nullable.GetUnderlyingType(type);
        if (underlying is not null) return Sample(underlying, depth);

        if (type == typeof(string)) return "x";
        if (type == typeof(bool)) return true;
        if (type == typeof(int)) return 1;
        if (type == typeof(long)) return 2L;
        if (type == typeof(short)) return (short)3;
        if (type == typeof(sbyte)) return (sbyte)4;
        if (type == typeof(byte)) return (byte)5;
        if (type == typeof(uint)) return 6U;
        if (type == typeof(ulong)) return 7UL;
        if (type == typeof(ushort)) return (ushort)8;
        if (type == typeof(float)) return 1.5F;
        if (type == typeof(double)) return 2.5D;
        if (type == typeof(decimal)) return 3.5M;
        if (type == typeof(DateTimeOffset)) return new DateTimeOffset(2024, 1, 2, 3, 4, 5, TimeSpan.Zero);
        if (type == typeof(DateTime)) return new DateTime(2024, 1, 2, 3, 4, 5, DateTimeKind.Utc);
        if (type == typeof(DateOnly)) return new DateOnly(2024, 1, 2);
        if (type == typeof(TimeOnly)) return new TimeOnly(3, 4, 5);
        if (type == typeof(TimeSpan)) return TimeSpan.FromSeconds(90);
        if (type == typeof(Guid)) return new Guid("0f8fad5b-d9cb-469f-a165-70867728950e");
        if (type == typeof(Uri)) return new Uri("https://example.test/a");
        if (type == typeof(byte[])) return new byte[] { 0xFB, 0xFF };
        if (type == typeof(JsonElement)) return JsonDocument.Parse("1").RootElement.Clone();
        if (type == typeof(object)) return "x";
        if (type.IsEnum)
        {
            var values = Enum.GetValues(type);
            return values.Length > 0 ? values.GetValue(0) : Activator.CreateInstance(type);
        }

        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(List<>))
        {
            var list = (IList)Activator.CreateInstance(type)!;
            var item = Sample(type.GetGenericArguments()[0], depth + 1);
            if (item is not null) list.Add(item);
            return list;
        }

        if (type.IsGenericType && type.GetGenericTypeDefinition() == typeof(Dictionary<,>))
        {
            var dictionary = (IDictionary)Activator.CreateInstance(type)!;
            var item = Sample(type.GetGenericArguments()[1], depth + 1);
            if (item is not null) dictionary.Add("k", item);
            return dictionary;
        }

        if (!type.IsClass || depth > MaxDepth) return null;

        var concrete = type.IsAbstract
            ? type.GetCustomAttributes<JsonDerivedTypeAttribute>().Select(a => a.DerivedType).FirstOrDefault(t => !t.IsAbstract)
            : type;
        if (concrete is null) return null;

        var instance = Activator.CreateInstance(concrete)!;
        foreach (var property in concrete.GetProperties(BindingFlags.Public | BindingFlags.Instance))
        {
            if (property.SetMethod is null || property.GetIndexParameters().Length > 0) continue;
            if (property.GetCustomAttribute<JsonExtensionDataAttribute>() is not null) continue;
            property.SetValue(instance, Sample(property.PropertyType, depth + 1));
        }

        return instance;
    }
}
