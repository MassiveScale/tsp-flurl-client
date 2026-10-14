using System.Reflection;
using System.Text.RegularExpressions;
using MassiveScale.Testing;

var assembly = typeof(Matrix.Client.MatrixClient).Assembly;

if (args is ["--framework-names", var directory])
{
    return ListFrameworkNames(assembly, directory);
}

// Every model and enum of the matrix client, through the client's own serializer settings.
var (checkedTypes, failures) = ContractSmoke.Check(assembly);
foreach (var failure in failures)
{
    Console.Error.WriteLine(failure);
}

Console.WriteLine($"{checkedTypes.Count} models and enums checked, {failures.Count} failed.");
return failures.Count == 0 ? 0 : 1;

/// <summary>
/// Prints every framework type the generated C# in a directory names without qualification:
/// each public type of a namespace the files import whose simple name (or, for an attribute,
/// the name without <c>Attribute</c>) appears as a word in them. One line each:
/// <c>name arity namespace</c>.
/// </summary>
static int ListFrameworkNames(Assembly generated, string directory)
{
    var files = Directory.EnumerateFiles(directory, "*.cs", SearchOption.AllDirectories)
        .Where(f => !f.Contains($"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}"))
        .ToList();
    var text = string.Join("\n", files.Select(File.ReadAllText));
    var imported = Regex.Matches(text, @"^using ([A-Za-z0-9_.]+);", RegexOptions.Multiline)
        .Select(m => m.Groups[1].Value)
        .ToHashSet();
    var words = Regex.Matches(text, @"(?<![\w.:])[A-Z][A-Za-z0-9_]*")
        .Select(m => m.Value)
        .ToHashSet();

    var assemblies = new Dictionary<string, Assembly>();
    void Load(Assembly a)
    {
        if (!assemblies.TryAdd(a.FullName!, a)) return;
        foreach (var reference in a.GetReferencedAssemblies())
        {
            try
            {
                Load(Assembly.Load(reference));
            }
            catch (FileNotFoundException)
            {
            }
        }
    }

    Load(generated);
    Load(typeof(object).Assembly);

    var found = new SortedSet<string>(StringComparer.Ordinal);
    foreach (var a in assemblies.Values)
    {
        Type[] types;
        try
        {
            types = a.GetExportedTypes();
        }
        catch (Exception)
        {
            continue;
        }

        foreach (var type in types.Where(t => !t.IsNested && t.Namespace is not null && imported.Contains(t.Namespace)))
        {
            var tick = type.Name.IndexOf('`');
            var name = tick < 0 ? type.Name : type.Name[..tick];
            var arity = type.IsGenericTypeDefinition ? type.GetGenericArguments().Length : 0;
            var attribute = typeof(Attribute).IsAssignableFrom(type) && name.EndsWith("Attribute", StringComparison.Ordinal)
                ? name[..^"Attribute".Length]
                : null;
            if (words.Contains(name) || (attribute is not null && words.Contains(attribute)))
            {
                found.Add($"{name} {arity} {type.Namespace}");
            }
        }
    }

    foreach (var line in found)
    {
        Console.WriteLine(line);
    }

    return 0;
}
