using Xunit;
using PruneSample;
namespace PruneSample.Tests;
public class CalcTests
{
    [Fact] public void Adds() => Assert.Equal(3, Calc.Add(1, 2));
    [Fact] public void AddsAgain() => Assert.Equal(3, Calc.Add(1, 2));
    [Fact] public void UsesReadySetup() { Setup.RequireReady(); Assert.True(Calc.Ready()); }
    [Fact] public void Unrelated() => Assert.Equal(4, 2 + 2);
}
public static class Setup
{
    public static void RequireReady()
    {
        if (!Calc.Ready()) throw new InvalidOperationException("service not ready");
    }
}
