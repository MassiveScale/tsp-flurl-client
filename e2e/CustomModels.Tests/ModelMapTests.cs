using AwesomeAssertions;
using MassiveScale.CustomModels.Client;

namespace CustomModels.Tests;

/// <summary><see cref="ModelMap"/> rejects mappings that could never work.</summary>
[TestClass]
public sealed class ModelMapTests
{
    private abstract record AbstractWidget : Widget;

    [TestMethod]
    public void Mapping_returns_the_map_so_calls_can_be_chained()
    {
        var map = new ModelMap();

        map.Map<Widget, MyWidget>().Should().BeSameAs(map);
    }

    [TestMethod]
    public void A_custom_type_that_does_not_derive_from_the_model_is_rejected()
    {
        var act = () => new ModelMap().Map(typeof(Widget), typeof(string));

        act.Should().Throw<ArgumentException>().WithMessage("*must derive from Widget*");
    }

    [TestMethod]
    public void An_abstract_custom_type_is_rejected()
    {
        var act = () => new ModelMap().Map(typeof(Widget), typeof(AbstractWidget));

        act.Should().Throw<ArgumentException>().WithMessage("*cannot be instantiated*");
    }

    [TestMethod]
    public void The_base_of_a_discriminated_hierarchy_cannot_be_mapped()
    {
        var act = () => new ModelMap().Map(typeof(Pet), typeof(Dog));

        act.Should().Throw<InvalidOperationException>().WithMessage("*Map one of its derived models*");
    }

    [TestMethod]
    public void A_null_argument_is_rejected()
    {
        new ModelMap().Invoking(m => m.Map(null!, typeof(Widget))).Should().Throw<ArgumentNullException>();
        new ModelMap().Invoking(m => m.Map(typeof(Widget), null!)).Should().Throw<ArgumentNullException>();
    }

    [TestMethod]
    public async Task Mapping_a_model_to_itself_removes_the_earlier_mapping()
    {
        var (client, handler) = Harness.Create(m => m.Map<Widget, MyWidget>().Map<Widget, Widget>());
        handler.RespondJson("""{"id":"1","name":"gear","sku":"S-1"}""");

        var widget = await client.Widgets("1").ReadAsync();

        widget.Should().BeOfType<Widget>();
    }
}
