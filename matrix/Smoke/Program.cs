using MassiveScale.Testing;

// Every model and enum of the matrix client, through the client's own serializer settings.
var assembly = typeof(Matrix.Client.MatrixClient).Assembly;
var (checkedTypes, failures) = ContractSmoke.Check(assembly);
foreach (var failure in failures)
{
    Console.Error.WriteLine(failure);
}

Console.WriteLine($"{checkedTypes.Count} models and enums checked, {failures.Count} failed.");
return failures.Count == 0 ? 0 : 1;
