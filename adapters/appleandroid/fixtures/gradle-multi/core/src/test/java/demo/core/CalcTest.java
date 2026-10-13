package demo.core;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.assertEquals;
class CalcTest {
    @Test void addWorks() { assertEquals(5, Calc.add(2, 3)); }
    @Test void mulWorks() { assertEquals(6, Calc.mul(2, 3)); }
}
