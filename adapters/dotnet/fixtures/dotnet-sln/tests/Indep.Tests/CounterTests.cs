using Fx.Indep;
using Xunit;

namespace Fx.IndepTests;

public class CounterTests
{
    [Fact]
    public void Counts()
    {
        var c = new Counter();
        c.Increment();
        Assert.Equal(1, c.Value);
    }
}
