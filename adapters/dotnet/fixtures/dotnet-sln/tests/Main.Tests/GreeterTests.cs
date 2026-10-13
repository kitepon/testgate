using Fx.Core;
using Xunit;

namespace Fx.Tests;

public class GreeterTests
{
    [Fact]
    public void Says_hello() => Assert.Equal("Hello, Zien", new Greeter().Hello("Zien"));

    [Fact]
    public void Says_hello_to_empty() => Assert.Equal("Hello, ", new Greeter().Hello(""));
}
